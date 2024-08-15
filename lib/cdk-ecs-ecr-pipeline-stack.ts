import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';

export interface CdkEcsEcrPipelineStackProps extends cdk.StackProps {
  vpcId: string;
  ecrRepositoryUri: string;
}

export class CdkEcsEcrPipelineStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: CdkEcsEcrPipelineStackProps) {
    super(scope, id, props);

    const { vpcId, ecrRepositoryUri } = props;

    // Import existing VPC
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: vpcId,
    });

    // Create a new security group for ECS tasks
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      description: 'Allow ECS tasks to access ECR',
      allowAllOutbound: true,
    });

    // Import existing ECR Repository
    const repository = ecr.Repository.fromRepositoryAttributes(this, 'ExistingEcrRepository', {
      repositoryArn: `arn:aws:ecr:${this.region}:${this.account}:repository/${ecrRepositoryUri.split('/')[1]}`,
      repositoryName: ecrRepositoryUri.split('/')[1],
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyEcsCluster', {
      vpc: vpc,
    });

    // Add EC2 capacity to the cluster with a key pair
    const autoScalingGroup = cluster.addCapacity('DefaultAutoScalingGroupCapacity', {
      instanceType: new ec2.InstanceType('t2.micro'),
      desiredCapacity: 2,
      keyName: 'dev-test', // 키 페어 이름 지정
    });

    // Attach the security group to the Auto Scaling Group
    autoScalingGroup.addSecurityGroup(ecsSecurityGroup);

    // Task Execution Role
    const taskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    // EC2 Task Definition
    const ec2TaskDefinition = new ecs.Ec2TaskDefinition(this, 'MyEc2TaskDefinition', {
      executionRole: taskExecutionRole,
    });

    const container = ec2TaskDefinition.addContainer('MyContainer', {
      image: ecs.ContainerImage.fromRegistry(`${ecrRepositoryUri}:latest`), // ECR에서 이미지를 가져옴
      memoryLimitMiB: 512,
      cpu: 256,//0.25vCPU 
      
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ecs',
      }),
    });
    container.addPortMappings({
      containerPort: 80,
    });


    // Create the ECS service
    const ec2Service = new ecs_patterns.ApplicationLoadBalancedEc2Service(this, 'MyEc2Service', {
      cluster,
      taskDefinition: ec2TaskDefinition,
      publicLoadBalancer: true, // 퍼블릭 로드 밸런서를 사용
      
    });

    // CodePipeline
    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    // CodeBuild Project
    const project = new codebuild.PipelineProject(this, 'MyProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true,
        environmentVariables: {
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account },
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)',
              'export AWS_DEFAULT_REGION=ap-northeast-2',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
              `REPOSITORY_URI=${ecrRepositoryUri}`,
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              'echo Generating imagedefinitions.json file...',
              'printf \'[{"name":"MyContainer","imageUri":"%s"}]\' $REPOSITORY_URI:latest > imagedefinitions.json',
            ],
          },
        },
        artifacts: {
          files: 'imagedefinitions.json',
        },
      }),
    });
 
    // Add the necessary permissions to the CodeBuild project's role
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
        'ecr:PutImage',
        'ecr:GetAuthorizationToken',  // 권한 추가
      ],
      resources: ['*'], // 모든 리소스에 대한 권한을 부여
    }));
 
    // Pipeline
    const pipeline = new codepipeline.Pipeline(this, 'MyPipeline', {
      pipelineName: 'MyEcrToEcsPipeline',
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.EcrSourceAction({
              actionName: 'ECR_Source',
              repository: repository,
              imageTag: 'latest',
              output: sourceOutput,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Generate_Image_Definitions',
              project: project,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new codepipeline_actions.EcsDeployAction({
              actionName: 'ECS_Deploy',
              service: ec2Service.service,
              imageFile: buildOutput.atPath('imagedefinitions.json'),
            }),
          ],
        },
      ],
    });
  }
}
