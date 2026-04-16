import { Construct } from "constructs";
import { CfnOutput, Duration } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import { Agent, AgentAlias } from "@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock";
import { CommonNodejsFunction } from "../../../common/constructs/lambda";

interface WhatsAppIntegrationProps {
    supervisorAgent: Agent;
    supervisorAgentAlias: AgentAlias;
}

export class WhatsAppIntegration extends Construct {
    public readonly webhookUrl: string;

    constructor(scope: Construct, id: string, props: WhatsAppIntegrationProps) {
        super(scope, id);

        // Lambda que recibe webhooks de WhatsApp y llama a Bedrock Agent
        const webhookHandler = new CommonNodejsFunction(this, "webhookHandler", {
            entry: require.resolve("./webhook-handler/index.ts"),
            memorySize: 512,
            timeout: Duration.minutes(2),
            environment: {
                // Estos valores se llenan automáticamente del deploy
                BEDROCK_AGENT_ID: props.supervisorAgent.agentId,
                BEDROCK_AGENT_ALIAS_ID: props.supervisorAgentAlias.aliasId,
                // Estos valores los configura el cliente después del deploy
                // desde la consola de AWS Lambda > Environment variables
                META_VERIFY_TOKEN: "CONFIGURAR_DESPUES_DEL_DEPLOY",
                META_ACCESS_TOKEN: "CONFIGURAR_DESPUES_DEL_DEPLOY",
                META_PHONE_NUMBER_ID: "CONFIGURAR_DESPUES_DEL_DEPLOY",
            },
        });

        // Permiso para invocar el Bedrock Agent
        webhookHandler.addToRolePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock:InvokeAgent"],
                resources: ["*"],
            })
        );

        // API Gateway REST para recibir webhooks de Meta Cloud API
        const api = new apigateway.RestApi(this, "whatsappApi", {
            restApiName: "kroni-whatsapp-webhook",
            description: "Webhook endpoint para integración con WhatsApp via Meta Cloud API",
        });

        const webhook = api.root.addResource("webhook");

        // GET /webhook — Verificación del webhook (Meta envía esto al configurar)
        webhook.addMethod("GET", new apigateway.LambdaIntegration(webhookHandler));

        // POST /webhook — Mensajes entrantes de WhatsApp
        webhook.addMethod("POST", new apigateway.LambdaIntegration(webhookHandler));

        this.webhookUrl = api.url + "webhook";

        // Exportar la URL del webhook para que el cliente la configure en Meta
        new CfnOutput(scope, "WhatsAppWebhookURL", {
            value: api.url + "webhook",
            description: "URL para configurar como webhook en Meta Business Manager",
        });
    }
}
