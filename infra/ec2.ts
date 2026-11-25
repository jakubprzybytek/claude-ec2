// The Claude Code instance's launch template, brought under the stack (prod only; the other stages use it through
// prod). Phase 1 manages only the template; the instance, its role, security group and the GitHub token parameter
// are still managed by hand (docs/development.md, "Deviations").
//
// It was created by hand and imported as is (lt-09036c7e82f2ca477, version 8): these arguments must match it, or the
// import fails. Any later change creates a new template version; `retainOnDelete` and `protect` keep it if the
// stack or this code goes away. An instance launched before a change keeps running with what it was launched with:
// the setup script runs once, at the first boot.

import { readFileSync } from "node:fs";
import { INSTANCE_NAME_TAG, isProd } from "./stage";

const TEMPLATE_ID = "lt-09036c7e82f2ca477";

export const launchTemplate = isProd
  ? new aws.ec2.LaunchTemplate(
      "ClaudeCodeTemplate",
      {
        name: "claude-code-ubuntu-arm",
        // Each version a deploy creates becomes the default: the CLI's `launch` runs the template by name, which
        // takes the default version.
        updateDefaultVersion: true,
        // The description of the current version; a change here goes into the next version.
        description: "Cost tag sst:app on the instance, its volume and network interface",
        imageId: "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id",
        instanceType: "t4g.medium",
        keyName: "aws-vscs",
        iamInstanceProfile: { name: "claude-code-ec2" },
        vpcSecurityGroupIds: ["sg-009616990588f8d57"],
        instanceInitiatedShutdownBehavior: "stop",
        blockDeviceMappings: [
          { deviceName: "/dev/sda1", ebs: { encrypted: "true", deleteOnTermination: "true", volumeSize: 30, volumeType: "gp3" } },
        ],
        metadataOptions: { httpTokens: "required", httpEndpoint: "enabled" },
        // sst:app (an active cost allocation tag) puts the instance, its disk and its public IPv4 under the app in
        // Cost Explorer; the instance running now was tagged by hand (2026-11-25).
        tagSpecifications: [
          { resourceType: "instance", tags: { Name: INSTANCE_NAME_TAG, "sst:app": "claude-ec2" } },
          { resourceType: "volume", tags: { "sst:app": "claude-ec2" } },
          { resourceType: "network-interface", tags: { "sst:app": "claude-ec2" } },
        ],
        userData: Buffer.from(readFileSync("infra/ec2/user-data.sh", "utf8")).toString("base64"),
      },
      { import: TEMPLATE_ID, retainOnDelete: true, protect: true },
    )
  : undefined;
