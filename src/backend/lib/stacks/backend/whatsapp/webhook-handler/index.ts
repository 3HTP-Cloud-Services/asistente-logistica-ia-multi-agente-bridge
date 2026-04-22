import {
    BedrockAgentRuntimeClient,
    InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

const bedrockClient = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });

// Variables de entorno
const AGENT_ID = process.env.BEDROCK_AGENT_ID!;
const AGENT_ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS_ID!;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN!;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN!;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID!;

export const handler = async (event: any) => {
    console.log("Event received:", JSON.stringify(event));

    // ============================================
    // GET /webhook — Verificación del webhook de Meta
    // Meta envía hub.mode, hub.verify_token y hub.challenge
    // Si el token coincide, respondemos con hub.challenge
    // ============================================
    if (event.httpMethod === "GET") {
        const params = event.queryStringParameters || {};
        const mode = params["hub.mode"];
        const token = params["hub.verify_token"];
        const challenge = params["hub.challenge"];

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("Webhook verified successfully");
            return {
                statusCode: 200,
                body: challenge,
            };
        }
        return { statusCode: 403, body: "Verification failed" };
    }

    // ============================================
    // POST /webhook — Mensaje entrante de WhatsApp
    // ============================================
    try {
        const body = JSON.parse(event.body || "{}");

        // Extraer el mensaje del payload de Meta
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        // Ignorar si no es un mensaje de texto
        if (!message || message.type !== "text") {
            return { statusCode: 200, body: "OK" };
        }

        const userPhone = message.from; // Número de teléfono de la usuaria
        const userMessage = message.text.body; // Texto del mensaje
        const sessionId = userPhone; // Usar el teléfono como session ID (memoria conversacional)

        console.log(`Message from ${userPhone}: ${userMessage}`);

        // ============================================
        // Llamar a Bedrock Agent (Supervisor)
        // ============================================
        const agentResponse = await invokeBedrockAgent(sessionId, userMessage);
        console.log(`Agent response: ${agentResponse}`);

        // ============================================
        // Enviar respuesta de vuelta por WhatsApp
        // TODO: El cliente debe configurar META_ACCESS_TOKEN y META_PHONE_NUMBER_ID
        // ============================================
        if (ACCESS_TOKEN !== "CONFIGURAR_DESPUES_DEL_DEPLOY") {
            await sendWhatsAppMessage(userPhone, agentResponse);
        } else {
            console.log("META_ACCESS_TOKEN not configured. Skipping WhatsApp response.");
            console.log("Response that would be sent:", agentResponse);
        }

        return { statusCode: 200, body: "OK" };
    } catch (error) {
        console.error("Error processing message:", error);
        return { statusCode: 200, body: "OK" }; // Siempre 200 para que Meta no reintente
    }
};

/**
 * Invoca el Bedrock Supervisor Agent con el mensaje del usuario
 * y devuelve la respuesta como texto
 */
async function invokeBedrockAgent(sessionId: string, message: string): Promise<string> {
    const command = new InvokeAgentCommand({
        agentId: AGENT_ID,
        agentAliasId: AGENT_ALIAS_ID,
        sessionId: sessionId,
        inputText: message,
    });

    const response = await bedrockClient.send(command);

    // Leer la respuesta del stream
    let fullResponse = "";
    if (response.completion) {
        for await (const chunk of response.completion) {
            if (chunk.chunk?.bytes) {
                fullResponse += new TextDecoder().decode(chunk.chunk.bytes);
            }
        }
    }

    return fullResponse || "Lo siento, no pude procesar tu mensaje. Intenta de nuevo.";
}

/**
 * Envía un mensaje de texto por WhatsApp usando Meta Cloud API
 */
async function sendWhatsAppMessage(to: string, message: string): Promise<void> {
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            to: to,
            type: "text",
            text: { body: message },
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        console.error(`WhatsApp API error: ${error}`);
    }
}
