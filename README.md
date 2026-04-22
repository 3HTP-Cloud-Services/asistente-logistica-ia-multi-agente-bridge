# Multi-Agent Orchestration on AWS

## Introduction

This project implements a **multi-agent AI customer support system** using Amazon Bedrock Agents. The system uses a Supervisor Agent that receives every user message, analyzes the intent, and delegates to the most appropriate specialized sub-agent. Each sub-agent has access to specific data sources — either structured databases via SQL or unstructured document collections via semantic search.

The architecture is designed to be **channel-agnostic**: the same AI backend can respond through WhatsApp or through a web application, depending on how it is deployed. This is controlled by a single configuration flag, making it easy to start simple and expand later.

The system comes with two deployment modes:

- **Mode 1 — WhatsApp only**: Deploy only the AI backend and connect it to WhatsApp via Meta Cloud API. No web frontend required. Ideal for companies that already have their own frontend, use WhatsApp as their primary support channel, or want to validate the AI before investing in a full web deployment.

- **Mode 2 — Full stack**: Deploy everything in Mode 1 plus a complete web application with Cognito authentication, CloudFront CDN, WAF protection, and a real-time chat interface. Ideal for teams that want a ready-to-use web UI alongside WhatsApp, or for demos and internal testing.

Both modes share the same Bedrock agents, Knowledge Bases, Athena databases, and S3 data. The only difference is the frontend infrastructure.

---

## Agents

The system has one Supervisor Agent and four specialized sub-agents:

| Agent | Role | How it gets data |
|---|---|---|
| **Supervisor Agent** | Receives every message, identifies intent, delegates to the right sub-agent, and returns the final response | — |
| **SA1 — Order Management** | Handles order status, tracking numbers, returns, and inventory queries | Executes SQL queries against Amazon Athena via Action Groups |
| **SA2 — Product Recommendation** | Suggests products based on purchase history and customer preferences | Combines Athena SQL queries with semantic search over a Knowledge Base |
| **SA3 — Troubleshooting** | Resolves technical issues and answers FAQs | Semantic search over a Knowledge Base with FAQ documents and product guides |
| **SA4 — Personalization** | Retrieves and applies customer profile data for tailored responses | Combines Athena SQL queries with semantic search over a Knowledge Base |

**How the Supervisor decides which sub-agent to use:**
The Supervisor Agent reads the user's message and matches it against the description of each sub-agent. For example, if the user asks "Where is my order?", the Supervisor routes to SA1. If they ask "What products do you recommend for me?", it routes to SA2. If multiple topics are involved, the Supervisor can call sub-agents sequentially and combine their responses.

---

## Deployment Modes

Controlled by `config/project-config.json`:

```json
{
  "features": {
    "deployCognito": false,
    "deployFrontend": false,
    "deployWAF": false
  }
}
```

| Flag | `false` | `true` |
|---|---|---|
| `deployCognito` | No Cognito, no DynamoDB, no WebSocket | Deploys Cognito User Pool, DynamoDB sessions, AppSync WebSocket |
| `deployFrontend` | No web UI | Deploys S3 website bucket + CloudFront distribution |
| `deployWAF` | No WAF | Deploys WAF Web ACL in front of CloudFront |

---

## Mode 1 — WhatsApp only

### Architecture

![Architecture Mode 1 - WhatsApp](docs/kit/images/Bridge.png)

### How it works

In this mode, the only entry point is the WhatsApp channel. There is no web application, no Cognito, and no DynamoDB. The infrastructure is minimal: API Gateway + Lambda + Bedrock Agents + Knowledge Bases + Athena.

**Complete flow:**

1. User sends a WhatsApp message
2. Meta Cloud API receives the message and forwards it via HTTP POST to the API Gateway webhook URL
3. API Gateway routes the request to the webhook-handler Lambda
4. Lambda extracts the message text and the user's phone number, then calls Bedrock InvokeAgent (sessionId = phone number, which enables conversation memory per user)
5. Bedrock Supervisor Agent analyzes the message and delegates to the right sub-agent:
   - Order queries → SA1 (Order Management)
   - Product questions → SA2 (Product Recommendation)
   - Technical issues → SA3 (Troubleshooting)
   - Profile/preferences → SA4 (Personalization)
6. Sub-agent executes its query:
   - SA1/SA2/SA4: runs a SQL query against Athena → Glue catalog → S3 data
   - SA3: searches the Knowledge Base using vector search over FAQ documents
7. Sub-agent returns the result to the Supervisor Agent
8. Supervisor Agent composes the final response
9. Lambda sends the response back via Meta Graph API
10. User receives the response on WhatsApp

### Real example

> **User:** "Hi, I want to know where my order #45231 is"
>
> **Supervisor Agent:** Identifies intent = order tracking → delegates to SA1
>
> **SA1 (Order Management):** Generates SQL query:
> `SELECT status, tracking_number, estimated_delivery FROM orders WHERE order_id = '45231'`
> → Executes via Athena → Returns: `{status: "In transit", tracking: "DHL-789456", delivery: "Apr 25"}`
>
> **Supervisor Agent:** Composes response → Lambda → Meta API
>
> **User receives on WhatsApp:** "Your order #45231 is currently in transit with DHL. Tracking number: DHL-789456. Estimated delivery: April 25."

---

## Mode 2 — Full stack

### Architecture

![Architecture Mode 2 - Full Stack](docs/kit/images/genai-mac-arch-diagram.png)

### How it works

Mode 2 adds a complete web application on top of Mode 1. Users can access the system through a browser in addition to WhatsApp. Both channels use the same Bedrock agents — the only difference is how the message arrives and how the response is delivered.

**Complete flow (web channel):**

1. User opens the web app in their browser
2. Traffic passes through AWS WAF (security filtering) → CloudFront (CDN) → S3 Website Bucket (serves the React app)
3. User logs in via Amazon Cognito
4. User types a message in the chat interface
5. AWS Amplify sends the message to the AppSync WebSocket API
6. Lambda receives the message, stores the session in DynamoDB, and calls Bedrock InvokeAgent (same flow as Mode 1 from this point)
7. Bedrock Supervisor Agent → Sub-agents → Athena / Knowledge Bases
8. Lambda receives the response and publishes it to AppSync
9. The browser receives the response in real time via WebSocket and displays it in the chat interface

**WhatsApp channel in Mode 2:**
The WhatsApp channel works exactly the same as in Mode 1. Both channels coexist — a user can interact via WhatsApp and another via the web app simultaneously, each with their own session.

### Real example

> **User (web app):** "What products do you recommend for me based on my purchase history?"
>
> **Supervisor Agent:** Identifies intent = product recommendation → delegates to SA2
>
> **SA2 (Product Recommendation):**
> 1. Queries Athena: `SELECT product_id, category FROM purchase_history WHERE customer_id = 'C-001' ORDER BY date DESC LIMIT 10`
> 2. Searches Knowledge Base: finds customer feedback documents mentioning similar products
> 3. Combines both results
>
> **Supervisor Agent:** Composes personalized response
>
> **User sees in the web chat:** "Based on your recent purchases in the electronics category, I recommend: [Product A] — highly rated by customers with similar profiles, [Product B] — frequently bought together with your last order."

---

## Cost

All prices are **on-demand, US East (N. Virginia) — us-east-1**, sourced from official AWS pricing pages.

### Assumptions

- **500 active users, 5 messages/day = 75,000 messages/month**
- Each message triggers 2 agent invocations: Supervisor + 1 sub-agent
- Per invocation: ~1,000 input tokens + 500 output tokens
- ~25% of messages use Knowledge Base (SA3 — Troubleshooting)
- 1 shared Aurora PostgreSQL Serverless v2 instance (0.5 ACU min) for all 4 Knowledge Bases
- VPC uses 2 AZs → 2 NAT Gateways (1 per AZ, required for Aurora private subnets)
- No separate Bedrock Agents invocation fee — only model token usage is charged

---

### Calculator 1 — Mode 1: WhatsApp only (`deployCognito: false`)

**Deployed:** 5 Bedrock Agents · 4 Knowledge Bases · Aurora pgvector · Lambda · API Gateway · Athena + Glue · S3 · VPC (2 NAT GWs) · Secrets Manager · CloudWatch

**Assumptions:** 500 active users · 5 messages/day = 75,000 messages/month · Supervisor invoked on every message (2 req/min × 24h) · Sub-agents invoked on 50% of messages each (1 req/min × 24h) · Cross-region inference

| AWS Service | Monthly Cost |
|---|---|
| Amazon Bedrock — Nova Pro (Supervisor Agent, cross-region inference) | $207.36 |
| Amazon Bedrock — Nova Micro (SA1 Order Mgmt + SA3 Troubleshooting) | $4.54 |
| Amazon Bedrock — Nova Lite (SA2 Product Rec + SA4 Personalization) | $7.78 |
| Amazon Bedrock — Titan Text Embeddings V2 (Knowledge Bases) | $0.19 |
| Amazon Aurora PostgreSQL Serverless v2 (vector store for all 4 KBs) | $49.27 |
| AWS Lambda (webhook handler + action group executor) | $0.01 |
| Amazon API Gateway (WhatsApp webhook endpoint) | $0.24 |
| Amazon S3 (KB documents + structured data CSVs) | $0.09 |
| Amazon VPC + NAT Gateway (2 AZs, required for Aurora) | $65.74 |
| AWS Secrets Manager (Aurora credentials) | $0.41 |
| Amazon CloudWatch (logs + metrics) | $8.53 |
| Amazon Athena (SQL queries from SA1, SA2, SA4) | $2.67 |
| AWS Glue (data catalog for Athena) | $0.06 |
| **TOTAL** | **~$346.89/month** |

> The NAT Gateway (~$66) is the largest fixed infrastructure cost because Aurora requires private subnets. If the client already has a VPC with NAT Gateways, this cost is eliminated.
>
> Full estimate: https://calculator.aws/#/estimate?id=2d81ed71a7b1970df7df2c3814cfed030e09e902

<!-- PASTE AWS CALCULATOR SCREENSHOT HERE — MODE 1 -->

---

### Calculator 2 — Mode 2: Full stack (`deployCognito: true`)

**What gets deployed:** Everything in Mode 1 + Cognito · WAF · CloudFront · S3 website · AppSync WebSocket · DynamoDB · Amplify

| AWS Service | Unit Price | Monthly Usage | Monthly Cost |
|---|---|---|---|
| **Nova Pro** — Supervisor Agent | $0.24/1M in · $0.97/1M out | 75K × 1K in + 500 out tokens | 75M×$0.24 + 37.5M×$0.97 = **$54.38** |
| **Nova Micro** — SA1 + SA3 | $0.035/1M in · $0.14/1M out | 37.5K × 1K in + 500 out | 37.5M×$0.035 + 18.75M×$0.14 = **$3.94** |
| **Nova Lite** — SA2 + SA4 | $0.06/1M in · $0.24/1M out | 37.5K × 1K in + 500 out | 37.5M×$0.06 + 18.75M×$0.24 = **$6.75** |
| **Titan Text Embeddings V2** | $0.02/1M tokens | ~18,750 KB queries × 500 tokens | **$0.19** |
| **Aurora PostgreSQL Serverless v2** | $0.06/ACU-hour + $0.10/GB/month | 0.5 ACU × 720h + 5 GB storage | **$22.10** |
| **AWS Lambda** — webhook + action groups + AppSync resolvers | $0.20/1M req + compute | 200K req × 2s × 512MB | **$4.00** |
| **Amazon API Gateway** — WhatsApp webhook | $3.50/1M requests | 75,000 requests | **$0.26** |
| **Amazon Athena** | $5.00/TB scanned | ~56K queries × 10MB avg | **$2.80** |
| **AWS Glue** | $1.00/100K requests | catalog requests | **$0.10** |
| **Amazon S3** — data + KB docs + website bucket | $0.023/GB + requests | 6 GB storage + requests | **$2.00** |
| **VPC + NAT Gateway** (2 AZs) | $0.045/h + $0.045/GB | 2 NAT GWs × 720h + 3 GB | 2×720×$0.045 + 3×$0.045 = **$65.07** |
| **AWS Secrets Manager** | $0.40/secret/month | 1 secret | **$0.40** |
| **Amazon CloudWatch** | $0.30/GB ingested | 6 GB logs + metrics | **$6.00** |
| **Amazon Cognito** | Free up to 50K MAU/month | 500 MAU | **$0.00** |
| **AWS WAF** | $5/WebACL + $1/rule/month | 1 WebACL + 3 rules | **$8.00** |
| **Amazon CloudFront** | $0.0085/10K HTTPS req + $0.085/GB | 100K requests + 5 GB transfer | **$0.51** |
| **Amazon DynamoDB** — chat sessions | $0.25/GB + $1.25/1M writes | 5 GB + 75K session writes | **$1.34** |
| **AWS Amplify** | $0.01/build min | ~240 build min/mo | 240×$0.01 = **$2.40** |
| **AWS AppSync** — WebSocket | $4.00/1M conn-min | 75K sessions × 2 min | 0.15M×$4 = **$0.60** |
| **TOTAL** | | | **~$180/month** |

> Cognito is free for the first 50,000 MAUs/month. At 500 users, there is no Cognito charge.

<!-- PASTE AWS CALCULATOR SCREENSHOT OR LINK HERE — MODE 2 -->

---

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) — Step-by-step deployment guide (prerequisites, both modes, troubleshooting, expected results)

---

## License

[Amazon Software License 1.0](/LICENSE)
