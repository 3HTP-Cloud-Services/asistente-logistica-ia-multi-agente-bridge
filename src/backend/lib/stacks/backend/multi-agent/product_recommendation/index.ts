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

interface ProductRecommendationSubAgentProps {
    loggingBucket: Bucket;
    executorFunction: Function;
}

export class ProductRecommendationSubAgent extends Construct {
    public readonly agentCollaborator: AgentCollaborator;
    public readonly knowledgeBaseId: string;
    public readonly agent: Agent;
    public readonly agentAlias: AgentAlias;

    constructor(scope: Construct, id: string, props: ProductRecommendationSubAgentProps) {
        super(scope, id);

        const { loggingBucket, executorFunction } = props;

        // OPTIMIZACIÓN: Knowledge Base con S3 Vectors (sin Aurora, sin VPC, sin NAT Gateways)
        const productRecommendationKB = new S3VectorsKnowledgeBase(this, "productRecKB", {
            name: "product-recommendation-kb",
            instruction: "Use this knowledge base to retrieve product information and recommendations.",
        });

        const productRecommendationKnowledgeBucket = new CommonBucket(
            this,
            "productRecommendationKnowledgeBucket",
            {
                serverAccessLogsBucket: loggingBucket,
            }
        );

        // Crear Data Source usando L1
        const productRecDataSource = new bedrock.CfnDataSource(
            this,
            "productRecDataSource",
            {
                knowledgeBaseId: productRecommendationKB.knowledgeBaseId,
                name: "productRecommendation-data",
                dataSourceConfiguration: {
                    type: "S3",
                    s3Configuration: {
                        bucketArn: productRecommendationKnowledgeBucket.bucketArn,
                    },
                },
            }
        );

        // Dar permisos al role de la KB para leer del bucket S3
        productRecommendationKnowledgeBucket.grantRead(productRecommendationKB.role);

        const productRecommendationIngestionRule = new Rule(
            this,
            "productRecommendationIngestionRule",
            {
                eventPattern: {
                    source: ["aws.s3"],
                    detail: {
                        bucket: {
                            name: [productRecommendationKnowledgeBucket.bucketName],
                        },
                    },
                },
                targets: [
                    new AwsApi({
                        service: "bedrock-agent",
                        action: "startIngestionJob",
                        parameters: {
                            knowledgeBaseId: productRecommendationKB.knowledgeBaseId,
                            dataSourceId: productRecDataSource.attrDataSourceId,
                        },
                    }),
                ],
            }
        );

        // Deploy knowledge base documents
        const productRecommendationKnowledgeDeployment = new BucketDeployment(
            this,
            "productRecommendationKnowledgeDeployment",
            {
                sources: [Source.asset(path.join(__dirname, "knowledge-base"))],
                destinationBucket: productRecommendationKnowledgeBucket,
                exclude: [".DS_Store"],
                prune: true,
            }
        );
        productRecommendationKnowledgeDeployment.node.addDependency(
            productRecommendationIngestionRule
        );

        // Sync checker
        const productRecommendationSyncChecker = new KnowledgeBaseSyncChecker(this, "productRecommendationSyncChecker", {
            knowledgeBaseIds: [productRecommendationKB.knowledgeBaseId],
            serviceName: "product-recommendation-kb-sync-checker",
            checkIntervalHours: 24,
        });

        const productRecommendationActionGroup = new AgentActionGroup({
            name: "productRecommendationActionGroup",
            description: "Handles user personalization queries from Athena or the knowledge base.",
            executor: ActionGroupExecutor.fromlambdaFunction(executorFunction),
            apiSchema: InlineApiSchema.fromLocalAsset(
                path.join(__dirname, "..", "action-group", "schema.json")
            ),
        });

        const model = BedrockFoundationModel.AMAZON_NOVA_LITE_V1;

        const productRecommendationInferenceProfile = CrossRegionInferenceProfile.fromConfig({
            geoRegion: CrossRegionInferenceProfileRegion.US,
            model: model,
        });

        // Crear agente SIN knowledgeBases (se asocia después con L1)
        const productRecommendationAgent = new Agent(this, "productRecommendationAgent", {
            foundationModel: productRecommendationInferenceProfile,
            instruction: readFileSync(path.join(__dirname, "instructions.txt"), "utf-8"),
            actionGroups: [productRecommendationActionGroup],
            userInputEnabled: true,
            shouldPrepareAgent: true,
            idleSessionTTL: Duration.seconds(1800),
        });

        // Asociar Knowledge Base al agente usando Custom Resource (API call)
        new AwsCustomResource(this, "productRecKBAssociation", {
            onCreate: {
                service: "BedrockAgent",
                action: "associateAgentKnowledgeBase",
                parameters: {
                    agentId: productRecommendationAgent.agentId,
                    agentVersion: "DRAFT",
                    knowledgeBaseId: productRecommendationKB.knowledgeBaseId,
                    description: "Use this knowledge base to retrieve product information and recommendations.",
                    knowledgeBaseState: "ENABLED",
                },
                physicalResourceId: PhysicalResourceId.of(`product-rec-kb-assoc-${Date.now()}`),
            },
            onDelete: {
                service: "BedrockAgent",
                action: "disassociateAgentKnowledgeBase",
                parameters: {
                    agentId: productRecommendationAgent.agentId,
                    agentVersion: "DRAFT",
                    knowledgeBaseId: productRecommendationKB.knowledgeBaseId,
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

        productRecommendationAgent.role.addToPrincipalPolicy(
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
                    productRecommendationInferenceProfile.inferenceProfileArn,
                    productRecommendationKB.knowledgeBaseArn,
                ],
            })
        );

        const productRecommendationAgentAlias = new AgentAlias(this, "alias", {
            agent: productRecommendationAgent,
        });

        const productRecommendationAgentCollaborator = new AgentCollaborator({
            agentAlias: productRecommendationAgentAlias,
            collaborationInstruction: "Expert in suggesting relevant products based on customer needs.",
            collaboratorName: "ProductRecommendation",
            relayConversationHistory: true,
        });

        this.agentCollaborator = productRecommendationAgentCollaborator;
        this.knowledgeBaseId = productRecommendationKB.knowledgeBaseId;
        this.agent = productRecommendationAgent;
        this.agentAlias = productRecommendationAgentAlias;
    }
}
