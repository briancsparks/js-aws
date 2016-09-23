
/**
 *
 */
var sg                  = require('sgsg');
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var helpers             = require('../helpers');
var awsJsonLib          = require('aws-json');

var jsVpc               = ra.require('./vpc', __dirname);

var AwsJson             = awsJsonLib.AwsJson;
var _                   = sg._;
var argvGet             = sg.argvGet;
var deref               = sg.deref;
var die                 = sg.die;
var lastIpInCidrBlock   = sg.lastIpInCidrBlock;
var ipNumber            = sg.ipNumber;
var dottedIp            = sg.dottedIp;

var cf = {};

var awsCf = new aws.CloudFormation({region: 'us-east-1'});

cf.createStack = function(argv, context, callback) {
  var config = {};

  var options = {
    namespace     : argvGet(argv, 'namespace,ns'),
    classB        : argvGet(argv, 'class-b,classb')
  };

  return jsVpc.getRouteTables(function(err, routeTables) {
    var dbRouteTables = sg._reduce(routeTables, {}, function(m, value, key) {
      return sg.kvSmart(m, deref(value, 'Tags.mario.dbRole'), value);
    });

    var mainDbRouteTable        = dbRouteTables.main;         // Might be undefined
    var secondaryDbRouteTable   = dbRouteTables.secondary;    // Might be undefined

    return jsVpc.getVpcs(function(err, vpcs) {
      var dbVpcs = sg._reduce(vpcs, {}, function(m, value, key) {
        return sg.kvSmart(m, deref(value, 'Tags.mario.dbRole'), value);
      });

      var mainDbVpc             = dbVpcs.main;         // Might be undefined
      var secondaryDbVpc        = dbVpcs.secondary;    // Might be undefined

      var subnet, cidr, numCidrBits = 20;
      var cfJson  = new awsJsonLib.CloudFormationJson(options);
      var vpc     = cfJson.vpc();

      vpc.cidrBlock(options.classB);
      vpc.enableDnsSupport();
      vpc.enableDnsHostnames();

      // ----- subnetA - for az 'a' -----
      cidr      = '10.21.0.0/'+numCidrBits;
      subnet    = addSubnet('SubnetA', 'a', cidr);

      // ----- subnetB - for az 'b' -----
      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
      subnet    = addSubnet('SubnetB', 'b', cidr);

      // ----- subnetD - for az 'd' -----
      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
      subnet    = addSubnet('SubnetD', 'd', cidr);

      // ----- subnetE - for az 'e' -----
      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
      subnet    = addSubnet('SubnetE', 'e', cidr);


      // ----- lambdaSubnetA - for az 'a' -----
      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
      subnet    = addSubnet('lambdaSubnetA', 'a', cidr);

      // ----- lambdaSubnetB - for az 'b' -----
      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
      subnet    = addSubnet('lambdaSubnetB', 'b', cidr);

      // ----- lambdaSubnetD - for az 'd' -----
      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
      subnet    = addSubnet('lambdaSubnetD', 'd', cidr);

      // ----- lambdaSubnetE - for az 'e' -----
      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
      subnet    = addSubnet('lambdaSubnetE', 'e', cidr);


      // ----- Security Groups -----
      var sgWide = vpc.securityGroup('sgWide');

      sgWide.groupDescription('For wide use');
      sgWide.ingress(-1, -1, -1, '10.0.0.0/8');
      sgWide.ingress('tcp', 22, 22, '0.0.0.0/0');
      sgWide.setTag(options.namespace+':applyToServices', 'all');

      // ----- Peering to the DB vpcs -----
      if (mainDbVpc && mainDbRouteTable) {
        vpc.peeringConnection(sg.octet2(mainDbVpc.CidrBlock), mainDbVpc.VpcId, mainDbRouteTable.RouteTableId);
      }

      if (secondaryDbVpc && secondaryDbRouteTable) {
        vpc.peeringConnection(sg.octet2(secondaryDbVpc.CidrBlock), secondaryDbVpc.VpcId, secondaryDbRouteTable.RouteTableId);
      }

      // Create endpoint to S3
      vpc.s3Endpoint([vpc.publicRouteTable]);

      config.TemplateBody = cfJson.toJson();
      config.StackName    = argvGet(argv, 'stack-name,stackname,aws-stack-name');

      //var stackResult = {}, err;
      return awsCf.createStack(config, function(err, stackResult) {
        if (err) { return die(err, callback, 'cf.createStack.createStack'); }

        return callback(null, _.extend({}, stackResult, {template: JSON.parse(config.TemplateBody)}));
      });

      function addSubnet(name, letter, cidr) {
        var subnet  = vpc.subnet(name, letter);

        subnet.cidrBlock2(cidr);
        subnet.mapPublicIpOnLaunch();

        return subnet;
      }
    });
  });
};

sg.exportify(module, cf);


