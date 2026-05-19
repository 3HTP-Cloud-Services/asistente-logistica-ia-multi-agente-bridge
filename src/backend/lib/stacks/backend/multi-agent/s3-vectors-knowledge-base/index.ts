import { Construct } from "constructs";
import { Stack } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * Construct que crea una Knowledge Base de Bedrock usando S3 Vectors como vector store.
 * 
 * OPTIMIZACIÓN DE COSTOS:
 * - Elimina la necesidad de Aurora PostgreSQL (~$49/mes)
 * - Elimina la necesidad de VPC + NAT Gateways (~$66/mes)
 * - S3 Vectors cobra solo por uso: $0.06/GB almacenado + $0.0025/1K queries
 * - Para volúmenes bajos (<10K queries/mes), el costo es prácticamente $0
 * 
 * REQUISITOS:
 * - aws-cdk-lib >= 2.243.0 (para aws_s3vectors)
 * - S3 Vectors disponible en us-east-1
 */

export interface S3VectorsKnowledgeBaseProps {
    /**
     * Nombre descriptivo para la Knowledge Base
     */
    readonly name: string;

    /**
     * Instrucción que describe cuándo usar esta Knowledge Base
     */
    readonly instruction: string;

    /**
     * Dimensiones del modelo de embeddings (1024 para Titan Embed Text V2)
     * @default 1024
     */
    readonly embeddingsDimension?: number;

    /**
     * Modelo de embeddings a usar
     * @default "amazon.titan-embed-text-v2:0"
     */
    readonly embeddingsModelArn?: string;
}

export class S3VectorsKnowledgeBase extends Construct {
    public readonly knowledgeBaseId: string;
    public readonly knowledgeBaseArn: string;
    public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
    public readonly vectorBucket: s3vectors.CfnVectorBucket;
    public readonly vectorIndex: s3vectors.CfnIndex;
    public readonly role: iam.Role;

    constructor(scope: Construct, id: string, props: S3VectorsKnowledgeBaseProps) {
        super(scope, id);

        const region = Stack.of(this).region;
        const account = Stack.of(this).account;
        const dimension = props.embeddingsDimension ?? 1024;
        const embeddingsModelArn = props.embeddingsModelArn ?? 
            `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`;

        // 1. Crear S3 Vector Bucket
        this.vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", {
            vectorBucketName: `${Stack.of(this).stackName}-${id}-vectors`.toLowerCase().substring(0, 63),
        });

        // 2. Crear Vector Index dentro del bucket (usando CfnIndex - L1 construct)
        this.vectorIndex = new s3vectors.CfnIndex(this, "VectorIndex", {
            vectorBucketName: this.vectorBucket.vectorBucketName!,
            indexName: `${id}-index`.toLowerCase(),
            dimension: dimension,
            distanceMetric: "cosine",
            dataType: "float32",
            metadataConfiguration: {
                nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT_CHUNK"],
            },
        });
        this.vectorIndex.addDependency(this.vectorBucket);

        // 3. Crear IAM Role para la Knowledge Base
        this.role = new iam.Role(this, "KBRole", {
            assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
            description: `Role for Bedrock Knowledge Base ${props.name}`,
        });

        // Permisos para invocar el modelo de embeddings
        this.role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["bedrock:InvokeModel"],
                resources: [embeddingsModelArn],
            })
        );

        // Permisos para S3 Vectors
        this.role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "s3vectors:GetVectorBucket",
                    "s3vectors:ListVectorBuckets",
                    "s3vectors:GetVectorIndex",
                    "s3vectors:ListVectorIndexes",
                    "s3vectors:PutVectors",
                    "s3vectors:GetVectors",
                    "s3vectors:DeleteVectors",
                    "s3vectors:QueryVectors",
                ],
                resources: [
                    this.vectorBucket.attrVectorBucketArn,
                    `${this.vectorBucket.attrVectorBucketArn}/*`,
                ],
            })
        );

        // Permisos para leer S3 (data source)
        this.role.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    "s3:GetObject",
                    "s3:ListBucket",
                ],
                resources: ["*"], // Se restringe después cuando se asocia el bucket de datos
            })
        );

        // 4. Crear la Knowledge Base con S3 Vectors como storage
        this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
            name: props.name,
            description: props.instruction,
            roleArn: this.role.roleArn,
            knowledgeBaseConfiguration: {
                type: "VECTOR",
                vectorKnowledgeBaseConfiguration: {
                    embeddingModelArn: embeddingsModelArn,
                    embeddingModelConfiguration: {
                        bedrockEmbeddingModelConfiguration: {
                            dimensions: dimension,
                        },
                    },
                },
            },
            storageConfiguration: {
                type: "S3_VECTORS",
                s3VectorsConfiguration: {
                    vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
                    indexName: this.vectorIndex.indexName ?? `${id}-index`.toLowerCase(),
                },
            },
        });
        this.knowledgeBase.addDependency(this.vectorIndex);
        this.knowledgeBase.node.addDependency(this.role);

        this.knowledgeBaseId = this.knowledgeBase.attrKnowledgeBaseId;
        this.knowledgeBaseArn = this.knowledgeBase.attrKnowledgeBaseArn;
    }
}
