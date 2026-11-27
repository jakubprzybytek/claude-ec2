// Sign-in (an app client of the shared pool) and the API: one function behind API Gateway's Cognito JWT authorizer.

import { apiThrottling, COGNITO_POOL_ID, domain, fullAccessGroups, INSTANCE_NAME_TAG, isProd, readOnlyGroups } from "./stage";

const region = aws.getRegionOutput().name;
const accountId = aws.getCallerIdentityOutput({}).accountId;

// One client per stage, no secret. The site's login form uses SRP (the password never leaves the browser); no hosted
// login page. Off prod the tests also sign in with a plain password (USER_PASSWORD_AUTH); never on prod.
export const webClient = new aws.cognito.UserPoolClient("WebClient", {
  name: `claude-ec2-${$app.stage}-web`,
  userPoolId: COGNITO_POOL_ID,
  explicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", ...(isProd ? [] : ["ALLOW_USER_PASSWORD_AUTH"])],
  generateSecret: false,
  preventUserExistenceErrors: "ENABLED",
  enableTokenRevocation: true,
  accessTokenValidity: 60,
  idTokenValidity: 60,
  refreshTokenValidity: 30,
  tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "days" },
});

export const api = new sst.aws.ApiGatewayV2("Api", {
  cors: { allowOrigins: [`https://${domain}`, ...(isProd ? [] : ["http://localhost:5173"])], allowHeaders: ["authorization", "content-type"] },
  transform: {
    stage: (args) => {
      args.defaultRouteSettings = apiThrottling;
    },
  },
});

const authorizer = api.addAuthorizer({
  name: "Cognito",
  jwt: { issuer: `https://cognito-idp.eu-west-1.amazonaws.com/${COGNITO_POOL_ID}`, audiences: [webClient.id] },
});

const instanceArn = $interpolate`arn:aws:ec2:${region}:${accountId}:instance/*`;
const tagged = (key: string) => [{ test: "StringEquals", variable: key, values: [INSTANCE_NAME_TAG] }];

// One function for every route (packages/api/src/handler.ts routes them).
const handler = new sst.aws.Function("ApiHandler", {
  handler: "packages/api/src/handler.handler",
  runtime: "nodejs24.x",
  architecture: "arm64",
  memory: "256 MB",
  // API Gateway waits 30 s; commands on the instance that take longer are polled by the site (GET /commands/{id}).
  timeout: "29 seconds",
  logging: { retention: "1 month" },
  nodejs: { loader: { ".sh": "text" } },
  environment: {
    FULL_ACCESS_GROUPS: fullAccessGroups.join(","),
    READ_ONLY_GROUPS: readOnlyGroups.join(","),
    INSTANCE_NAME_TAG,
  },
  // Only the instance tagged Name=claude-code, only these actions (the permissions boundary caps them as well).
  permissions: [
    { actions: ["ec2:DescribeInstances", "ssm:DescribeInstanceInformation", "ssm:GetCommandInvocation"], resources: ["*"] },
    { actions: ["ec2:StartInstances", "ec2:StopInstances", "ec2:ModifyInstanceAttribute"], resources: [instanceArn], conditions: tagged("aws:ResourceTag/Name") },
    { actions: ["ssm:SendCommand"], resources: [instanceArn], conditions: tagged("ssm:resourceTag/Name") },
    { actions: ["ssm:SendCommand"], resources: [$interpolate`arn:aws:ssm:${region}::document/AWS-RunShellScript`] },
    // The account's costs (GET /costs). Cost Explorer actions take no resource scope.
    { actions: ["ce:GetCostAndUsage", "ce:GetCostForecast"], resources: ["*"] },
    // Starting an instance with an encrypted volume: EC2 uses the volume's KMS key on the caller's behalf.
    {
      actions: ["kms:CreateGrant", "kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncryptFrom", "kms:ReEncryptTo"],
      resources: [$interpolate`arn:aws:kms:${region}:${accountId}:key/*`],
      conditions: [{ test: "StringEquals", variable: "kms:ViaService", values: [$interpolate`ec2.${region}.amazonaws.com`] }],
    },
  ],
});

const auth = { auth: { jwt: { authorizer: authorizer.id } } };
for (const route of [
  "GET /status",
  "GET /status/details",
  "POST /instance/start",
  "POST /instance/stop",
  "POST /instance/resize",
  "POST /autostop/snooze",
  "POST /commands",
  "GET /commands/{id}",
  "GET /sessions",
  "POST /sessions",
  "DELETE /sessions/{name}",
  "GET /conversations",
  "POST /login",
  "POST /login/code",
  "DELETE /login",
  "GET /costs",
]) {
  api.route(route, handler.arn, auth);
}
