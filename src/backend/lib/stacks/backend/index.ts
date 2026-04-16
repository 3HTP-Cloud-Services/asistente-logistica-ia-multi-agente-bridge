import { StackProps } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { FeaturesConfig } from "../../../../../config";
import { CommonStack } from "../../common/constructs/stack";
import { Auth } from "./auth";
import { MultiAgent } from "./multi-agent";
import { Storage } from "./storage";
import { StreamingApi } from "./streaming-api";
import { WhatsAppIntegration } from "./whatsapp";

interface BackendStackProps extends StackProps {
    urls: string[];
    features: FeaturesConfig;
}

export class BackendStack extends CommonStack {
    public readonly environmentVariables: Record<string, string>;

    constructor(scope: Construct, id: string, props: BackendStackProps) {
        super(scope, id, props);

        const { features } = props;

        NagSuppressions.addStackSuppressions(this, [
            {
                id: "AwsSolutions-IAM4",
                reason: "Lambda functions require managed policies to interface with the vpc.",
            },
        ]);

        const storage = new Storage(this, "storage", {
            urls: props.urls,
        });

        const multiAgent = new MultiAgent(this, "multiAgent", {
            athenaResultsBucket: storage.athenaResultsBucket,
            structuredDataBucket: storage.structuredDataBucket,
        });

        // Integración con WhatsApp (siempre se despliega)
        const whatsapp = new WhatsAppIntegration(this, "whatsapp", {
            supervisorAgent: multiAgent.supervisorAgent,
            supervisorAgentAlias: multiAgent.supervisorAgentAlias,
        });

        // Variables de entorno base (siempre disponibles)
        this.environmentVariables = {
            VITE_REGION: this.region!,
            VITE_CALLBACK_URL: props.urls[0],
            VITE_STORAGE_BUCKET_NAME: storage.structuredDataBucket.bucketName,
            VITE_SUPERVISOR_AGENT_ID: multiAgent.supervisorAgent.agentId,
            VITE_SUPERVISOR_ALIAS_ID: multiAgent.supervisorAgentAlias.aliasId,
            VITE_PRODUCT_RECOMMENDATION_AGENT_ID: multiAgent.productRecommendationSubAgent.agent.agentId,
            VITE_PRODUCT_RECOMMENDATION_ALIAS_ID: multiAgent.productRecommendationSubAgent.agentAlias.aliasId,
            VITE_PERSONALIZATION_AGENT_ID: multiAgent.personalizationSubAgent.agent.agentId,
            VITE_PERSONALIZATION_ALIAS_ID: multiAgent.personalizationSubAgent.agentAlias.aliasId,
            VITE_TROUBLESHOOT_AGENT_ID: multiAgent.troubleshootSubAgent.agent.agentId,
            VITE_TROUBLESHOOT_ALIAS_ID: multiAgent.troubleshootSubAgent.agentAlias.aliasId,
            VITE_ORDER_MANAGEMENT_AGENT_ID: multiAgent.orderManagementSubAgent.agent.agentId,
            VITE_ORDER_MANAGEMENT_ALIAS_ID: multiAgent.orderManagementSubAgent.agentAlias.aliasId,
        };

        // Cognito + WAF + Streaming API solo si deployCognito es true
        if (features.deployCognito) {
            const auth = new Auth(this, "auth", {
                urls: props.urls,
            });
            storage.structuredDataBucket.grantReadWrite(auth.authenticatedRole);

            const streamingApi = new StreamingApi(this, "streamingApi", {
                userPool: auth.userPool,
                regionalWebAclArn: auth.regionalWebAclArn,
                supervisorAgent: multiAgent.supervisorAgent,
                supervisorAgentAlias: multiAgent.supervisorAgentAlias,
            });

            // Variables de entorno adicionales para el frontend
            this.environmentVariables = {
                ...this.environmentVariables,
                VITE_USER_POOL_ID: auth.userPool.userPoolId,
                ...(auth.userPoolDomain && {
                    VITE_USER_POOL_DOMAIN_URL: auth.userPoolDomain.baseUrl().replace("https://", ""),
                }),
                VITE_USER_POOL_CLIENT_ID: auth.userPoolClient.userPoolClientId,
                VITE_IDENTITY_POOL_ID: auth.identityPool.attrId,
                CODEGEN_GRAPH_API_ID: streamingApi.amplifiedGraphApi.apiId,
                VITE_GRAPH_API_URL: streamingApi.amplifiedGraphApi.graphqlUrl,
                VITE_WEBSOCKET_ENDPOINT: streamingApi.amplifiedGraphApi.realtimeUrl,
            };
        }
    }
}
