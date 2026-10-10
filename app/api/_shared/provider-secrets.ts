import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

// -----------------------------------------------------------------------------
// PROVIDER KEY NAMES
// -----------------------------------------------------------------------------
// One shared function supplies provider keys to every server route. Local
// development reads .env; AWS reads the JSON object stored in Secrets Manager.

export type ProviderApiKeyName =
  | "OPENAI_API_KEY"
  | "GEMINI_API_KEY"
  | "ELEVENLABS_API_KEY";

type ProviderSecret = Partial<Record<ProviderApiKeyName, string>>;

// -----------------------------------------------------------------------------
// AWS CLIENT AND WARM-LAMBDA CACHE
// -----------------------------------------------------------------------------
// Lambda supplies its Region and short-lived execution-role credentials to the
// AWS SDK. No AWS access keys belong in this application or its Docker image.

const secretsManagerClient = new SecretsManagerClient({});

let cachedProviderSecret: ProviderSecret | null = null;
let pendingProviderSecret: Promise<ProviderSecret> | null = null;

// -----------------------------------------------------------------------------
// LOAD AND VALIDATE THE AWS SECRET
// -----------------------------------------------------------------------------

async function retrieveProviderSecret(): Promise<ProviderSecret> {
  const secretArn = process.env.PROVIDER_SECRET_ARN?.trim();

  if (!secretArn) {
    throw new Error("PROVIDER_SECRET_ARN is not configured.");
  }

  const response = await secretsManagerClient.send(
    new GetSecretValueCommand({
      SecretId: secretArn,
      VersionStage: "AWSCURRENT",
    }),
  );

  if (!response.SecretString) {
    throw new Error("The provider secret must be stored as a JSON string.");
  }

  let parsedSecret: unknown;

  try {
    parsedSecret = JSON.parse(response.SecretString);
  } catch {
    throw new Error("The provider secret does not contain valid JSON.");
  }

  if (
    !parsedSecret ||
    typeof parsedSecret !== "object" ||
    Array.isArray(parsedSecret)
  ) {
    throw new Error("The provider secret must contain a JSON object.");
  }

  return parsedSecret as ProviderSecret;
}

async function loadProviderSecret(): Promise<ProviderSecret> {
  if (cachedProviderSecret) {
    return cachedProviderSecret;
  }

  // Concurrent requests during a cold start share one Secrets Manager call.
  // The parsed value then remains cached for this warm Lambda environment.
  if (!pendingProviderSecret) {
    pendingProviderSecret = retrieveProviderSecret()
      .then((secret) => {
        cachedProviderSecret = secret;
        return secret;
      })
      .finally(() => {
        pendingProviderSecret = null;
      });
  }

  return pendingProviderSecret;
}

// -----------------------------------------------------------------------------
// PUBLIC KEY LOOKUP
// -----------------------------------------------------------------------------

export async function getProviderApiKey(
  keyName: ProviderApiKeyName,
): Promise<string> {
  const secretArn = process.env.PROVIDER_SECRET_ARN?.trim();

  if (secretArn) {
    // Production mode: the presence of the ARN makes Secrets Manager the
    // authoritative source, even if another environment variable is present.
    const providerSecret = await loadProviderSecret();
    const storedValue = providerSecret[keyName];
    const value = typeof storedValue === "string" ? storedValue.trim() : "";

    if (!value || value.startsWith("replace-with-")) {
      throw new Error(`${keyName} is missing from the provider secret.`);
    }

    return value;
  }

  // Local mode: without an AWS secret ARN, retain the simple .env workflow.
  const localValue = process.env[keyName]?.trim();

  if (!localValue || localValue.startsWith("replace-with-")) {
    throw new Error(`${keyName} is not configured.`);
  }

  return localValue;
}
