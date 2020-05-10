import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as iam from '@aws-cdk/aws-iam';
import * as ssm from '@aws-cdk/aws-ssm';
import * as s3 from '@aws-cdk/aws-s3';
import * as rds from '@aws-cdk/aws-rds';
import { ApplicationLoadBalancedFargateService } from '@aws-cdk/aws-ecs-patterns';
import { join as pjoin } from 'path';

export interface AirflowOnEcsStackProps extends cdk.StackProps {
  repositoryUrl: string,
  syncBranch: string,
  dagsDirectory?: string,
  vpc: ec2.IVpc,
}

interface AirflowTaskDefinitionOption {
  airflowCommand: Array<string>,
  cpu: number,
  memoryLimitMiB: number,
  portMappings?: Array<ecs.PortMapping>
}

export class AirflowOnEcsStack extends cdk.Stack {
  private readonly airflowTemplate: ecs.ContainerDefinitionOptions
  private readonly gitSyncTemplate: ecs.ContainerDefinitionOptions;
  private static readonly dagsMountPoint = '/var/lib/git-data';
  public readonly taskRole: iam.IRole;

  constructor(scope: cdk.Construct, id: string, props: AirflowOnEcsStackProps) {
    super(scope, id, props);

    const artifactBucket = new s3.Bucket(this, 'Artifact');

    const dbUser = 'airflow';
    const db = new rds.DatabaseInstance(this, 'DB', {
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      instanceClass: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      masterUsername: dbUser,
      allocatedStorage: 20,
      vpc: props.vpc,
    });

    const repoName = 'repo';
    const dagFolder = props.dagsDirectory
      ? pjoin(AirflowOnEcsStack.dagsMountPoint, repoName, props.dagsDirectory)
      : pjoin(AirflowOnEcsStack.dagsMountPoint, repoName);
    this.airflowTemplate = {
      image: ecs.ContainerImage.fromRegistry('puckel/docker-airflow:1.10.9'),
      environment: {
        EXECUTOR: 'Celery',
        POSTGRES_HOST: db.instanceEndpoint.hostname,
        POSTGRES_PORT: cdk.Token.asString(db.instanceEndpoint.port),
        AIRFLOW__CORE__DAGS_FOLDER: dagFolder,
        AIRFLOW__CELERY__BROKER_URL: 'sqs://',
      },
      secrets: {
        POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
        FERNET_KEY: ecs.Secret.fromSsmParameter(ssm.StringParameter.fromSecureStringParameterAttributes(this, 'FernetKey', {
          parameterName: '/Airflow/FernetKey',
          version: 1,
        }))
      },
    }
    this.gitSyncTemplate = {
      image: ecs.ContainerImage.fromRegistry('k8s.gcr.io/git-sync:v3.1.6'),
      environment: {
        GIT_SYNC_REPO: props.repositoryUrl,
        GIT_SYNC_BRANCH: props.syncBranch,
        GIT_SYNC_DEST: repoName,
        GIT_SYNC_WAIT: '30',
      },
    }

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    artifactBucket.grantReadWrite(this.taskRole);
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      resources: ['arn:aws:sqs:*'],
      actions: ['sqs:*'],
    }))

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
    });
    new ApplicationLoadBalancedFargateService(this, 'WebServerService', {
      cluster,
      taskDefinition: this.airflowTaskDefinition('WebServerTaskDefinition', {
        cpu: 256,
        memoryLimitMiB: 1024,
        airflowCommand: ['webserver'],
        portMappings: [{ containerPort: 8080 }],
      }),
    });

    new ecs.FargateService(this, 'SchedulerService', {
      cluster,
      taskDefinition: this.airflowTaskDefinition('SchedulerTaskDefinition', { cpu: 256, memoryLimitMiB: 1024, airflowCommand: ['scheduler'] }),
    });

    new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition: this.airflowTaskDefinition('WorkerTaskDefinition', { cpu: 1024, memoryLimitMiB: 4096, airflowCommand: ['worker']}),
      desiredCount: 2,
    });
  }

  private airflowTaskDefinition(taskDefinitionName: string, airflowTaskDefinitionOption: AirflowTaskDefinitionOption): ecs.FargateTaskDefinition {
    const taskDef = new ecs.FargateTaskDefinition(this, taskDefinitionName, {
      volumes: [{ name: 'dags' }],
      taskRole: this.taskRole,
      ...airflowTaskDefinitionOption,
    });
    const airflowContainer = taskDef.addContainer('Airflow', { command: airflowTaskDefinitionOption.airflowCommand, ...this.airflowTemplate });
    airflowContainer.addMountPoints({
      sourceVolume: 'dags',
      containerPath: AirflowOnEcsStack.dagsMountPoint,
      readOnly: true,
    });
    if (airflowTaskDefinitionOption.portMappings) {
      airflowContainer.addPortMappings(...airflowTaskDefinitionOption.portMappings)
    }
    const gitSyncContainer = taskDef.addContainer('GitSync', this.gitSyncTemplate);
    gitSyncContainer.addMountPoints({
      sourceVolume: 'dags',
      containerPath: '/tmp/git',
      readOnly: false,
    });
    return taskDef
  }
}
