# Deployment Guide

---

## Table of Contents
1. [Step 1 — Select Region](#step-1--select-region)
2. [Step 2 — Enable Bedrock Models](#step-2--enable-bedrock-models)
3. [Step 3 — Install Prerequisites](#step-3--install-prerequisites)
4. [Step 4 — Clone & Install Dependencies](#step-4--clone--install-dependencies)
5. [Step 5 — Configure Account](#step-5--configure-account)
6. [Step 6 — Bootstrap CDK](#step-6--bootstrap-cdk)
7. [Step 7 — Authenticate to ECR](#step-7--authenticate-to-ecr)
8. [Step 8 — Deploy](#step-8--deploy)
9. [Step 9 — Save Deploy Outputs](#step-9--save-deploy-outputs)
10. [Step 10 — CloudFormation Stacks Created](#step-10--cloudformation-stacks-created)
11. [Step 11 — Configure Athena](#step-11--configure-athena)
12. [Step 12 — Web Frontend (optional)](#step-12--web-frontend-optional)

---

## Step 1 — Select Region

1. Sign in to the AWS Console
2. In the top-right corner, select **US East (N. Virginia) — us-east-1**
3. All project resources will be created in this region

---

## Step 2 — Enable Bedrock Models

The project requires 4 Amazon models. Enable them before deploying.

1. Go to **Amazon Bedrock → Model catalog**
2. For each model: click the model → **Request model access** → accept the EULA → confirm

| Model | Model ID | Used by |
|---|---|---|
| Amazon Nova Pro | `amazon.nova-pro-v1:0` | Supervisor Agent |
| Amazon Nova Lite | `amazon.nova-lite-v1:0` | SA2 Product Recommendation + SA4 Personalization |
| Amazon Nova Micro | `amazon.nova-micro-v1:0` | SA1 Order Management + SA3 Troubleshooting |
| Amazon Titan Text Embeddings V2 | `amazon.titan-embed-text-v2:0` | All Knowledge Bases |

> Each model must be enabled individually. Activation is instant.

**Verify all models are active** (run in AWS CloudShell):

```bash
REGION="us-east-1"
declare -A models
models=(
  ["Amazon Titan Embed Text V2"]="amazon.titan-embed-text-v2:0"
  ["Amazon Nova Micro"]="amazon.nova-micro-v1:0"
  ["Amazon Nova Lite"]="amazon.nova-lite-v1:0"
  ["Amazon Nova Pro"]="amazon.nova-pro-v1:0"
)
total=0; activos=0; fallidos=0
for name in "${!models[@]}"; do
  model_id="${models[$name]}"
  total=$((total + 1))
  status=$(aws bedrock list-foundation-models \
    --region "$REGION" \
    --query "modelSummaries[?modelId=='$model_id'].modelLifecycle.status" \
    --output text 2>/dev/null)
  if [ "$status" == "ACTIVE" ]; then
    echo "OK $name - ACTIVE"
    activos=$((activos + 1))
  else
    echo "FAIL $name - $status (go back and accept the EULA)"
    fallidos=$((fallidos + 1))
  fi
done
echo "--- $activos/$total models active ---"
```

---

## Step 3 — Install Prerequisites

### Docker

Required to build Python Lambda functions inside containers.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Rancher Desktop](https://rancherdesktop.io/) (free alternative)
2. Start Docker and verify it is running (icon in taskbar)
3. Verify: `docker --version`

> **Rancher Desktop only:** Go to Preferences → Container Engine → Allowed Images and add `public.ecr.aws/sam/build-python3.12:latest`

### AWS CLI

```bash
# Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

aws configure
# AWS Access Key ID: your key
# AWS Secret Access Key: your secret
# Default region name: us-east-1
# Default output format: json

aws sts get-caller-identity  # verify
```

### Node.js 18+

```bash
# Install: https://nodejs.org/
node --version
npm --version
```

### AWS CDK

```bash
npm install -g aws-cdk@latest
cdk --version  # must be 2.1118.0 or higher
```

### Git

```bash
# Install: https://git-scm.com/downloads
git --version
```

### Verify all prerequisites at once (PowerShell)

```powershell
Write-Host "=== Prerequisites Check ===" -ForegroundColor Cyan
$tools = @("docker", "aws", "node", "npm", "cdk", "git")
foreach ($cmd in $tools) {
    try {
        $version = & $cmd --version 2>&1 | Select-Object -First 1
        Write-Host "  $cmd - $version" -ForegroundColor Green
    } catch {
        Write-Host "  $cmd - NOT INSTALLED" -ForegroundColor Red
    }
}
$identity = aws sts get-caller-identity 2>&1
if ($identity -match "Account") {
    Write-Host "  AWS CLI configured correctly" -ForegroundColor Green
} else {
    Write-Host "  AWS CLI not configured - run: aws configure" -ForegroundColor Red
}
$dockerInfo = docker info 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Docker is running" -ForegroundColor Green
} else {
    Write-Host "  Docker is NOT running - start it before continuing" -ForegroundColor Red
}
```

---

## Step 4 — Clone & Install Dependencies

> **Important:** Do NOT clone inside OneDrive, Dropbox, or any cloud sync folder. Use a local path like `C:\Projects\`.

```bash
git clone https://github.com/aws-solutions-library-samples/guidance-for-multi-agent-orchestration-on-aws.git
cd guidance-for-multi-agent-orchestration-on-aws
npm install
```

The install may show warnings about deprecated packages or vulnerabilities — this is expected and does not affect functionality.

> **If `npm install` fails with E401:**
> ```bash
> npm config set registry https://registry.npmjs.org/
> rm package-lock.json
> npm install
> ```

---

## Step 5 — Configure Account

Open `config/project-config.json` in any text editor:

```bash
# Windows
notepad config\project-config.json
```

Replace `YOUR_ACCOUNT_ID` with your AWS account number and save:

```json
{
  "features": {
    "deployCognito": false,
    "deployFrontend": false,
    "deployWAF": false
  },
  "accounts": {
    "dev": {
      "number": "YOUR_ACCOUNT_ID",
      "region": "us-east-1"
    }
  }
}
```

Get your Account ID:
```bash
aws sts get-caller-identity --query "Account" --output text
```

**Leave the `features` flags as `false`** — this deploys only the AI agents and the WhatsApp channel, without any web frontend.

> **Optional — Enable web frontend:** See [Step 12](#step-12--web-frontend-optional). You can enable it at any time after the initial deployment.

---

## Step 6 — Bootstrap CDK

Run once per account/region. Creates the S3 bucket and IAM roles that CDK needs to deploy.

```bash
cdk bootstrap aws://YOUR_ACCOUNT_ID/us-east-1
```

---

## Step 7 — Authenticate to ECR

The project downloads a Docker image from AWS ECR to build Python Lambda functions.

```bash
aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws
```

> **On Windows — if you get "The stub received bad data":**
>
> Docker Desktop uses the Windows Credential Manager, which cannot store the long ECR token. Fix it:
>
> **1.** Open `~/.docker/config.json` and change `"credsStore": "desktop"` to `"credsStore": ""`
>
> **2.** Run in PowerShell:
> ```powershell
> $token = aws ecr-public get-login-password --region us-east-1
> $bytes = [System.Text.Encoding]::UTF8.GetBytes("AWS:$token")
> $encoded = [System.Convert]::ToBase64String($bytes)
> $config = Get-Content $HOME\.docker\config.json | ConvertFrom-Json
> $config.auths | Add-Member -NotePropertyName "public.ecr.aws" -NotePropertyValue @{auth=$encoded} -Force
> $config | ConvertTo-Json -Depth 5 | Set-Content $HOME\.docker\config.json
> ```
>
> **3.** Verify:
> ```bash
> docker pull public.ecr.aws/sam/build-python3.12:latest
> ```

---

## Step 8 — Deploy

```bash
npm run develop
```

1. Select **3. Deploy CDK Stack(s)**
2. Select environment: `dev`
3. Confirm: `yes`
4. Wait 15-30 minutes

---

## Step 9 — Save Deploy Outputs

After the deploy finishes, the terminal shows output values. **Save this value — you will need it to configure WhatsApp:**

| Output key | Description |
|---|---|
| `WhatsAppWebhookURL` | API Gateway URL — paste this as the webhook URL in Meta Business Manager |

If you lose it, find it in: **AWS Console → CloudFormation → `dev-mac-demo-backend` → Outputs tab**

---

## Step 10 — CloudFormation Stacks Created

After a successful deploy with `deployCognito: false`, these stacks will appear in CloudFormation:

| Stack | What it contains |
|---|---|
| `CDKToolkit` | CDK bootstrap infrastructure: S3 bucket for deployment assets, IAM roles. Created by `cdk bootstrap`. |
| `dev-mac-demo-backend` | The entire backend: Bedrock Agents (Supervisor + 4 sub-agents), Knowledge Bases, Aurora PostgreSQL (vector store), Lambda functions (webhook handler + action group executor), S3 data bucket, Athena + Glue data catalog, API Gateway (WhatsApp webhook endpoint), Secrets Manager (Aurora credentials), VPC + NAT Gateways. |

---

## Step 11 — Configure Athena

Required for agents that use SQL: SA1 (Order Management), SA2 (Product Recommendation), SA4 (Personalization).

1. AWS Console → **Amazon Athena** → Settings → **Manage**
2. Set query result location:
   ```
   s3://dev-mac-demo-backend-storageathenaresultsbucket-YOUR_ACCOUNT_ID/
   ```
3. Click **Save**

Find the exact bucket name:
```bash
aws s3 ls | grep athena
```

> Without this step, any message routed to SA1, SA2, or SA4 will fail silently.

---

## Step 12 — Web Frontend (optional)

Only needed if you want the web chat interface in addition to WhatsApp.

1. Edit `config/project-config.json`:
   ```json
   {
     "features": {
       "deployCognito": true,
       "deployFrontend": true,
       "deployWAF": true
     }
   }
   ```
2. Redeploy:
   ```bash
   npm run develop
   # Select: 3. Deploy CDK Stack(s)
   # Then: 5. Deploy Frontend
   ```
3. Create a Cognito user:
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id YOUR_USER_POOL_ID \
     --username testuser \
     --temporary-password "TempPass123!" \
     --user-attributes Name=email,Value=test@example.com \
     --region us-east-1
   ```
4. Open the `viteCallbackUrl` from the deploy output in your browser

To run locally:
```bash
npm run develop
# Select: 7. Test Frontend Locally
# Open: http://localhost:3000
```
