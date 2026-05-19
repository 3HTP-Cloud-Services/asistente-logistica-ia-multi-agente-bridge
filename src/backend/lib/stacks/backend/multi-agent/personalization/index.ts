import {
    ActionGroupExecutor,
    Agent,
    AgentActionGroup,
    AgentAlias,
    AgentCollaborator,
    BedrockFoundationModel,
    CrossRegionInferenceProfile,
    CrossRegionInferenceProfileRegion,
    InlineApiSchema,
} from "@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock";
import { Duration } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import { Rule } from "aws-cdk-lib/aws-events";
import { AwsApi } from "aws-cdk-lib/aws-events-targets";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { readFileSync } from "fs";
import * as path from "path";
import { CommonBucket } from "../../../../common/constructs/s3";
import { KnowledgeBaseSyncChecker } from "../kb-sync-checker/construct";
import { S3VectorsKnowledgeBase } from "../s3-vectors-knowledge-base";

interface PersonalizationSubAgentProps {
    loggingBucket: Bucket;
    executorFunction: Function;
}

export class PersonalizationSubAgent extends Construct {
    public readonly agentCollaborator: AgentCollaborator;
    public readonly knowledgeBaseId: string;
    public readonly agent: Agent;
    public readonly agentAlias: AgentAlias;

    constructor(scope: Construct, id: string, props: PersonalizationSubAgentProps) {
        super(scope, id);

        const { loggingBucket, executorFunction } = props;

        // OPTIMIZACIÓN: Knowledge Base con S3 Vectors (sin Aurora, sin VPC, sin NAT Gateways)
        // Ahorro: ~$115/mes en infraestructura fija
        const personalizationKB = new S3VectorsKnowledgeBase(this, "personalizationKB", {
            name: "personalization-kb",
            instruction: "Use this knowledge base to retrieve user preferences and browsing history.",
        });

        const personalizationKnowledgeBucket = new CommonBucket(
            this,
            "personalizationKnowledgeBucket",
            {
                serverAccessLogsBucket: loggingBucket,
            }
        );

        // Crear Data Source usando L1 (CfnDataSource)
        const personalizationDataSource = new bedrock.CfnDataSource(
            this,
            "personalizationDataSource",
            {
                knowledgeBaseId: personalizationKB.knowledgeBaseId,
                name: "personalization-data",
                dataSourceConfiguration: {
                    type: "S3",
                    s3Configuration: {
                        bucketArn: personalizationKnowledgeBucket.bucketArn,
                    },
                },
            }
        );

        // Dar permisos al role de la KB para leer del bucket S3
        personalizationKnowledgeBucket.grantRead(personalizationKB.role);

        const personalizationIngestionRule = new Rule(this, "personalizationIngestionRule", {
            eventPattern: {
                source: ["aws.s3"],
                detail: {
                    bucket: {
                        name: [personalizationKnowledgeBucket.bucketName],
                    },
                },
            },
            targets: [
                new AwsApi({
                    service: "bedrock-agent",
                    action: "startIngestionJob",
                    parameters: {
                        knowledgeBaseId: personalizationKB.knowledgeBaseId,
                        dataSourceId: personalizationDataSource.attrDataSourceId,
                    },
                }),
            ],
        });

        // Deploy knowledge base documents
        const personalizationKnowledgeDeployment = new BucketDeployment(
            this,
            "personalizationKnowledgeDeployment",
            {
                sources: [Source.asset(path.join(__dirname, "knowledge-base"))],
                destinationBucket: personalizationKnowledgeBucket,
                exclude: [".DS_Store"],
                prune: true,
            }
        );
        personalizationKnowledgeDeployment.node.addDependency(personalizationIngestionRule);

        // Sync checker
        const personalizationSyncChecker = new KnowledgeBaseSyncChecker(this, "personalizationSyncChecker", {
            knowledgeBaseIds: [personalizationKB.knowledgeBaseId],
            serviceName: "personalization-kb-sync-checker",
            checkIntervalHours: 24,
        });

        const personalizationActionGroup = new AgentActionGroup({
            name: "personalizationActionGroup",
            description: "Handles user personalization queries from Athena or the knowledge base.",
            executor: ActionGroupExecutor.fromlambdaFunction(executorFunction),
            apiSchema: InlineApiSchema.fromLocalAsset(
                path.join(__dirname, "..", "action-group", "schema.json")
            ),
        });

        const model = BedrockFoundationModel.AMAZON_NOVA_LITE_V1;

        const personalizationInferenceProfile = CrossRegionInferenceProfile.fromConfig({
            geoRegion: CrossRegionInferenceProfileRegion.US,
            model: model,
        });

        // Crear agente SIN knowledgeBases (se asocia después con L1)
        const personalizationAgent = new Agent(this, "personalizationAgent", {
            foundationModel: personalizationInferenceProfile,
            instruction: readFileSync(path.join(__dirname, "instructions.txt"), "utf-8"),
            actionGroups: [personalizationActionGroup],
            userInputEnabled: true,
            shouldPrepareAgent: true,
            idleSessionTTL: Duration.seconds(1800),
        });

        // Asociar Knowledge Base al agente usando Custom Resource (API call)
        new AwsCustomResource(this, "personalizationKBAssociation", {
            onCreate: {
                service: "BedrockAgent",
                action: "associateAgentKnowledgeBase",
                parameters: {
                    agentId: personalizationAgent.agentId,
                    agentVersion: "DRAFT",
                    knowledgeBaseId: personalizationKB.knowledgeBaseId,
                    description: "Use this knowledge base to retrieve user preferences and browsing history.",
                    knowledgeBaseState: "ENABLED",
                },
                physicalResourceId: PhysicalResourceId.of(`personalization-kb-assoc-${Date.now()}`),
            },
            onDelete: {
                service: "BedrockAgent",
                action: "disassociateAgentKnowledgeBase",
                parameters: {
                    agentId: personalizationAgent.agentId,
                    agentVersion: "DRAFT",
                    knowledgeBaseId: personalizationKB.knowledgeBaseId,
                },
            },
            policy: AwsCustomResourcePolicy.fromStatements([
                new PolicyStatement({
                    actions: [
                        "bedrock:AssociateAgentKnowledgeBase",
                        "bedrock:DisassociateAgentKnowledgeBase",
                    ],
                    resources: ["*"],
                }),
            ]),
        });

        personalizationAgent.role.addToPrincipalPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:GetInferenceProfile",
                    "bedrock:GetFoundationModel",
                    "bedrock:Retrieve",
                ],
                resources: [
                    `arn:aws:bedrock:*::foundation-model/${model.modelId}`,
                    personalizationInferenceProfile.inferenceProfileArn,
                    personalizationKB.knowledgeBaseArn,
                ],
            })
        );

        const personalizationAgentAlias = new AgentAlias(this, "alias", {
            agent: personalizationAgent,
        });

        const personalizationAgentCollaborator = new AgentCollaborator({
            agentAlias: personalizationAgentAlias,
            collaborationInstruction: "Expert in understanding customer preferences and personalizing experiences.",
            collaboratorName: "Personalization",
            relayConversationHistory: true,
        });

        this.agentCollaborator = personalizationAgentCollaborator;
        this.knowledgeBaseId = personalizationKB.knowledgeBaseId;
        this.agent = personalizationAgent;
        this.agentAlias = personalizationAgentAlias;
    }
}
