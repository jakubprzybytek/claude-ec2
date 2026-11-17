// The Claude Code instance: found by its Name tag, started, stopped and resized through the EC2 API, reached through
// SSM Run Command. Same rules as the CLI (cli/src/main.rs).

import {
  DescribeInstancesCommand,
  EC2Client,
  ModifyInstanceAttributeCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance as Ec2Instance,
} from "@aws-sdk/client-ec2";
import { DescribeInstanceInformationCommand, SSMClient } from "@aws-sdk/client-ssm";

export const ec2 = new EC2Client({});
export const ssm = new SSMClient({});

const NAME_TAG = () => process.env["INSTANCE_NAME_TAG"] ?? "claude-code";

/** Graviton (arm64) types only: the template's image is arm64, an x86 type would not boot. */
export const INSTANCE_TYPES = ["t4g.small", "t4g.medium", "t4g.large", "t4g.xlarge", "t4g.2xlarge", "m7g.large", "m7g.xlarge", "c7g.xlarge", "r7g.large"];

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Instance {
  id: string;
  state: string;
  type: string;
  zone: string;
  publicIp: string | null;
  launchTime: string | null;
}

const toInstance = (i: Ec2Instance): Instance => ({
  id: i.InstanceId ?? "",
  state: i.State?.Name ?? "unknown",
  type: i.InstanceType ?? "",
  zone: i.Placement?.AvailabilityZone ?? "",
  publicIp: i.PublicIpAddress ?? null,
  launchTime: i.LaunchTime ? i.LaunchTime.toISOString() : null,
});

/** The only non-terminated instance tagged Name=claude-code. */
export async function findInstance(): Promise<Instance> {
  const res = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [NAME_TAG()] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
    }),
  );
  const found = (res.Reservations ?? []).flatMap((r) => r.Instances ?? []).map(toInstance);
  if (found.length === 0) throw new HttpError(404, `No instance tagged Name=${NAME_TAG()}`);
  if (found.length > 1) throw new HttpError(409, `Several ${NAME_TAG()} instances: ${found.map((i) => i.id).join(", ")}`);
  return found[0]!;
}

export async function ssmOnline(id: string): Promise<boolean> {
  const res = await ssm.send(new DescribeInstanceInformationCommand({ Filters: [{ Key: "InstanceIds", Values: [id] }] }));
  return res.InstanceInformationList?.[0]?.PingStatus === "Online";
}

export async function start(): Promise<Instance> {
  const i = await findInstance();
  if (i.state === "stopping") throw new HttpError(409, "The instance is still stopping; start it once it has stopped");
  if (i.state === "stopped") await ec2.send(new StartInstancesCommand({ InstanceIds: [i.id] }));
  return { ...i, state: i.state === "stopped" ? "pending" : i.state };
}

export async function stop(): Promise<Instance> {
  const i = await findInstance();
  if (i.state === "running" || i.state === "pending") await ec2.send(new StopInstancesCommand({ InstanceIds: [i.id] }));
  return { ...i, state: i.state === "stopped" ? "stopped" : "stopping" };
}

export async function resize(type: string): Promise<Instance> {
  if (!INSTANCE_TYPES.includes(type)) throw new HttpError(400, `Instance type must be one of ${INSTANCE_TYPES.join(", ")}`);
  const i = await findInstance();
  if (i.state !== "stopped") throw new HttpError(409, `The instance is ${i.state}; stop it first`);
  if (i.type !== type) await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: i.id, InstanceType: { Value: type } }));
  return { ...i, type };
}

/** For calls that run something on the instance: it must be running and reachable over SSM. */
export async function requireReachable(): Promise<Instance> {
  const i = await findInstance();
  if (i.state !== "running") throw new HttpError(409, `The instance is ${i.state}`);
  if (!(await ssmOnline(i.id))) throw new HttpError(409, "The instance is running but Session Manager isn't online yet; try again in a minute");
  return i;
}
