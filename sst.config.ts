/// <reference path="./.sst/platform/config.d.ts" />

// A web app to control the Claude Code EC2 instance (README.md): a static site, an API behind the shared Cognito pool,
// and the instance's launch template (infra/ec2.ts). The CLI in cli/ does the same from a terminal.

export default $config({
  app(input) {
    return {
      name: "claude-ec2",
      home: "aws",
      providers: { aws: { region: "eu-west-1" } },
      removal: input?.stage === "prod" ? "retain" : "remove",
      protect: input?.stage === "prod",
    };
  },
  async run() {
    // Every IAM role carries the repo's permissions boundary (aws-github-deploy standard, rule 8).
    const { accountId } = await aws.getCallerIdentity({});
    $transform(aws.iam.Role, (args) => {
      args.permissionsBoundary = `arn:aws:iam::${accountId}:policy/claude-ec2-Boundary`;
    });

    const { launchTemplate } = await import("./infra/ec2");
    const { api, webClient } = await import("./infra/api");
    const { siteUrl } = await import("./infra/web");
    const { isProd, TEST_USER } = await import("./infra/stage");

    // Printed after a deploy and written to .sst/outputs.json (the pipeline's smoke checks read siteUrl).
    return {
      siteUrl,
      apiGateway: api.url,
      authClientId: webClient.id,
      ...(launchTemplate ? { launchTemplate: launchTemplate.id } : {}),
      ...(isProd ? {} : { testUser: TEST_USER }),
    };
  },
});
