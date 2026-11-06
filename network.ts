import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

export function createNetwork(
  opts: { orgId: string; region: string; cidr: string; azId: string },
  provider: aws.Provider
) {
  const [a, b] = opts.cidr.split('.');
  const tags = (name: string) => ({ Name: `tesser-${name}`, 'tesser:org': opts.orgId });
  const vpc = new aws.ec2.Vpc(
    'tesser',
    { cidrBlock: opts.cidr, enableDnsSupport: true, enableDnsHostnames: true, tags: tags('vpc') },
    { provider }
  );
  const igw = new aws.ec2.InternetGateway('tesser', { vpcId: vpc.id, tags: tags('igw') }, { provider });
  const publicSubnet = new aws.ec2.Subnet(
    'tesser-public',
    {
      vpcId: vpc.id,
      cidrBlock: `${a}.${b}.0.0/24`,
      availabilityZoneId: opts.azId,
      tags: { Name: 'tesser-public' },
    },
    { provider }
  );
  const publicRoutes = new aws.ec2.RouteTable(
    'tesser-public',
    { vpcId: vpc.id, routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: igw.id }], tags: { Name: 'tesser-public' } },
    { provider }
  );
  new aws.ec2.RouteTableAssociation(
    'tesser-public',
    { subnetId: publicSubnet.id, routeTableId: publicRoutes.id },
    { provider }
  );
  const natIp = new aws.ec2.Eip('tesser-nat', { domain: 'vpc', tags: tags('nat') }, { provider });
  const nat = new aws.ec2.NatGateway(
    'tesser',
    { subnetId: publicSubnet.id, allocationId: natIp.id, tags: tags('nat') },
    { provider, dependsOn: igw }
  );
  const subnet = new aws.ec2.Subnet(
    'tesser-boxes',
    { vpcId: vpc.id, cidrBlock: `${a}.${b}.16.0/20`, availabilityZoneId: opts.azId, tags: tags('boxes') },
    { provider }
  );
  const routes = new aws.ec2.RouteTable(
    'tesser-boxes',
    { vpcId: vpc.id, routes: [{ cidrBlock: '0.0.0.0/0', natGatewayId: nat.id }], tags: tags('boxes') },
    { provider }
  );
  new aws.ec2.RouteTableAssociation('tesser-boxes', { subnetId: subnet.id, routeTableId: routes.id }, { provider });
  new aws.ec2.VpcEndpoint(
    'tesser-s3',
    {
      vpcId: vpc.id,
      serviceName: pulumi.interpolate`com.amazonaws.${opts.region}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: [routes.id],
      tags: tags('s3'),
    },
    { provider }
  );
  return { vpcId: vpc.id, subnetId: subnet.id };
}
