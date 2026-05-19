import {
    Agent,
    AgentAlias,
    AgentCollaborator,
    BedrockFoundationModel,
} from "@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock";
import { Duration } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import { Rule } from "aws-cdk-lib/aws-events";
import { AwsApi } from "aws-cdk-lib/aws-events-targets";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { readFileSync } from "fs";
import * as path from "path";
import { CommonBucket } from "../../../../common/constructs/s3";
import { KnowledgeBaseSyncChecker } from "../kb-sync-checker/construct";
import { S3VectorsKnowledgeBase } from "../s3-vectors-knowledge-base";

interface TroubleshootSubAgentProps {
    loggingBucket: Bucket;
}

export class TroubleshootSubAgent extends Construct {
    public readonly agentCollaborator: AgentCollaborator;
    public readonly knowledgeBaseId: string;
    public readonly agent: Agent;
    public readonly agentAlias: AgentAlias;

    constructor(scope: Construct, id: string, props: TroubleshootSubAgentProps) {
        super(scope, id);

        const { loggingBucket } = props;

        // OPTIMIZACIÓN: Knowledge Base con S3 Vectors (sin Aurora, sin VPC, sin NAT Gateways)
        const troubleshootKB = new S3VectorsKnowledgeBase(this, "troubleshootKB", {
            name: "troubleshoot-kb",
            instruction: "Use this knowledge base to retrieve troubleshooting guides and FAQs.",
        });

        const troubleshootKnowledgeBucket = new CommonBucket(this, "troubleshootKnowledgeBucket", {
            serverAccessLogsBucket: loggingBucket,
        });

        // Crear Data Source usando L1
        const troubleshootDataSource = new bedrock.CfnDataSource(
            this,
            "troubleshootDataSource",
            {
                knowledgeBaseId: troubleshootKB.knowledgeBaseId,
                name: "troubleshoot-data",
                dataSourceConfiguration: {
                    type: "S3",
                    s3Configuration: {
                        bucketArn: troubleshootKnowledgeBucket.bucketArn,
                    },
                },
            }
        );

        // Dar permisos al role de la KB para leer del bucket S3
        troubleshootKnowledgeBucket.grantRead(troubleshootKB.role);

        const troubleshootIngestionRule = new Rule(this, "troubleshootIngestionRule", {
            eventPattern: {
                source: ["aws.s3"],
                detail: {
                    bucket: {
                        name: [troubleshootKnowledgeBucket.bucketName],
                    },
                },
            },
            targets: [
                new AwsApi({
                    service: "bedrock-agent",
                    action: "startIngestionJob",
                    parameters: {
                        knowledgeBaseId: troubleshootKB.knowledgeBaseId,
                        dataSourceId: troubleshootDataSource.attrDataSourceId,
                    },
                }),
            ],
        });

        // Deploy knowledge base documents
        const troubleshootKnowledgeDeployment = new BucketDeployment(
            this,
            "troubleshootKnowledgeDeployment",
            {
                sources: [Source.asset(path.join(__dirname, "knowledge-base"))],
                destinationBucket: troubleshootKnowledgeBucket,
                exclude: [".DS_Store"],
                prune: true,
            }
        );
        troubleshootKnowledgeDeployment.node.addDependency(troubleshootIngestionRule);

        // Sync checker
        const troubleshootSyncChecker = new KnowledgeBaseSyncChecker(this, "troubleshootSyncChecker", {
            knowledgeBaseIds: [troubleshootKB.knowledgeBaseId],
            serviceName: "troubleshoot-kb-sync-checker",
            checkIntervalHours: 24,
        });

        const model = BedrockFoundationModel.AMAZON_NOVA_MICRO_V1;

        // Crear agente SIN knowledgeBases (se asocia después con L1)
        const troubleshootAgent = new Agent(this, "troubleshootAgent", {
            foundationModel: model,
            instruction: readFileSync(path.join(__dirname, "instructions.txt"), "utf-8"),
            userInputEnabled: true,
            shouldPrepareAgent: true,
            idleSessionTTL: Duration.seconds(1800),
        });

        // Asociar Knowledge Base al agente usando Custom Resource (API call)
        new AwsCustomResource(this, "troubleshootKBAssociation", {
            onCreate: {
                service: "BedrockAgent",
                action: "associateAgentKnowledgeBase",
                parameters: {
                    agentId: troubleshootAgent.agentId,
                    agentVersion: "DRAFT",
                    knowledgeBaseId: troubleshootKB.knowledgeBaseId,
                    description: "Use this knowledge base to retrieve troubleshooting guides and FAQs.",
                    knowledgeBaseState: "ENABLED",
                },
                physicalResourceId: PhysicalResourceId.of(`troubleshoot-kb-assoc-${Date.now()}`),
            },
            onDelete: {
                service: "BedrockAgent",
                action: "disassociateAgentKnowledgeBase",
                parameters: {
                    agentId: troubleshootAgent.agentId,
                    agentVersion: "DRAFT",
                    knowledgeBaseId: troubleshootKB.knowledgeBaseId,
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

        troubleshootAgent.role.addToPrincipalPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:GetFoundationModel",
                    "bedrock:Retrieve",
                ],
                resources: [
                    `arn:aws:bedrock:*::foundation-model/${model.modelId}`,
                    troubleshootKB.knowledgeBaseArn,
                ],
            })
        );

        const troubleshootAgentAlias = new AgentAlias(this, "alias", {
            agent: troubleshootAgent,
        });

        const troubleshootAgentCollaborator = new AgentCollaborator({
            agentAlias: troubleshootAgentAlias,
            collaborationInstruction: "Expert in technical support, problem resolution, and answers to frequently asked questions for products and services.",
            collaboratorName: "Troubleshoot",
            relayConversationHistory: true,
        });

        this.agentCollaborator = troubleshootAgentCollaborator;
        this.knowledgeBaseId = troubleshootKB.knowledgeBaseId;
        this.agent = troubleshootAgent;
        this.agentAlias = troubleshootAgentAlias;
    }
}
