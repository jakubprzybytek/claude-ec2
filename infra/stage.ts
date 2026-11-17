// Stage-specific settings live here, so the infra code checks flags instead of stage names (docs/development.md).

export const isProd = $app.stage === "prod";

/** The instance every stage controls: there is only one, so dev controls the real one too (read-only in the tests). */
export const INSTANCE_NAME_TAG = "claude-code";

// Shared, manually managed pool (AlbedoUserPool) used by several apps; anyone can sign up to it, so the API checks
// the group. The test user's group is read-only, and only off prod: the tests never change the real instance.
export const COGNITO_POOL_ID = "eu-west-1_IVai0KEAA";
export const TEST_USER = "claude-ec2-test@albedoonline.com";
export const fullAccessGroups = ["claude-ec2"];
export const readOnlyGroups = isProd ? [] : ["claude-ec2-test"];

// prod → claude-ec2.albedoonline.com, any other stage → <stage>.claude-ec2.albedoonline.com
const ROOT_DOMAIN = "claude-ec2.albedoonline.com";
export const domain = isProd ? ROOT_DOMAIN : `${$app.stage}.${ROOT_DOMAIN}`;

// The API sits behind Cognito JWT authorization, so no request without a sign-in runs a function
// (aws-app-guidelines: not a public entry point). Throttling still bounds a signed-in client gone wrong: the app
// itself makes a few requests a minute while a page is open.
export const apiThrottling = { throttlingRateLimit: 5, throttlingBurstLimit: 20 };
