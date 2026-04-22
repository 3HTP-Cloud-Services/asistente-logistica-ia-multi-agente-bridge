import { Aspects, Stage, StageProps } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { projectConfig } from "../../../config";
import { BackendStack } from "./stacks/backend";
import { FrontendDeploymentStack, FrontendStack } from "./stacks/frontend";

export class ApplicationStage extends Stage {
    constructor(scope: Construct, id: string, props: StageProps) {
        super(scope, id, props);
        
        // Set CDK_DEFAULT_REGION for the AWS PowerTools layer
        process.env.CDK_DEFAULT_REGION = props.env?.region || 'us-east-1';

        // Leer features del config (por defecto todo activado para compatibilidad)
        const features = projectConfig.features ?? {
            deployCognito: true,
            deployFrontend: true,
            deployWAF: true,
        };

        // Frontend solo se despliega si deployFrontend es true
        let urls = ["https://localhost:3000"];
        let frontend: FrontendStack | undefined;

        if (features.deployFrontend) {
            frontend = new FrontendStack(this, "frontend");
            urls = frontend.urls;
        }

        const backend = new BackendStack(this, "backend", {
            urls,
            features,
        });

        // Frontend deployment solo si hay frontend
        if (features.deployFrontend && frontend) {
            new FrontendDeploymentStack(this, "frontendDeployment", {
                websiteBucket: frontend.websiteBucket,
                distribution: frontend.distribution,
                environmentVariables: backend.environmentVariables,
            });
        }

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Lambda functions require the AWSLambdaBasicExecutionRole to write logs to CloudWatch.",
                    appliesTo: [
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                    ],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "High-level constructs require wildcards for dynamic resource creation and management.",
                },
                {
                    id: "AwsSolutions-L1",
                    reason: "High-level constructs set their own runtimes.",
                },
            ],
            true
        );
        //Aspects.of(this).add(new AwsSolutionsChecks());
    }
}
