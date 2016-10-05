
/**
 *  The js-aws version of the AWS CloudFormation API.
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
var toCapitalCase       = helpers.toCapitalCase;

var cf = {};

var awsCf = new aws.CloudFormation({region: 'us-east-1'});

/**
 *  Create a Cloud Formation stack.
 */
cf.createStack = function(argv, context, callback) {
  var config = {};

  var mainDbRouteTable, secondaryDbRouteTable;
  var mainDbVpc,        secondaryDbVpc;
  var cfJson,           stackResult;
  var vpc;

  var region          = argv.region             || argv.r                 || 'us-east-1';
  var cidrBlock       = argv.cidr_block         || argv.cidr              || '10.199.0.0/16';
  var numBitsPublic   = argv.num_bits_public    || argv.public_size       || 24;
  var numBitsPrivate  = argv.num_bits_private   || argv.private_size      || 20;
  var numBitsPrivate2 = argv.num_bits_private2  || argv.private2_size     || 23;
  var numAzs          = argv.num_azs            || argv.num_az            || 4;
  var numSubnetsPerAz = argv.num_subnets_per_az || argv.num_subnets       || 3;
  var namespace       = argv.namespace                                    || 'toad';

  if (argv.classb && !(argv.cidr_block || argv.cidr)) {
    cidrBlock         = '10.999.0.0/16'.replace('999', argv.classb);
  }

  return sg.__runll([function(next) {
    return jsVpc.getRouteTables(function(err, routeTables) {
      var dbRouteTables = sg._reduce(routeTables, {}, function(m, value, key) {
        return sg.kvSmart(m, deref(value, 'Tags.mario.dbRole'), value);
      });

      mainDbRouteTable        = dbRouteTables.main;         // Might be undefined
      secondaryDbRouteTable   = dbRouteTables.secondary;    // Might be undefined

      return next();
    });

  }, function(next) {
    return jsVpc.getVpcs(function(err, vpcs) {
      var dbVpcs = sg._reduce(vpcs, {}, function(m, value, key) {
        return sg.kvSmart(m, deref(value, 'Tags.mario.dbRole'), value);
      });

      mainDbVpc             = dbVpcs.main;         // Might be undefined
      secondaryDbVpc        = dbVpcs.secondary;    // Might be undefined

      return next();
    });

  }], function() {
    return sg.__run([function(next) {

      var i, letter;

      cfJson          = new awsJsonLib.CloudFormationJson(argv);
      vpc             = cfJson.vpc();

      vpc.cidrBlock(cidrBlock);
      vpc.enableDnsSupport();
      vpc.enableDnsHostnames();
      vpc.setTag('Name', argvGet(argv, 'stack-name,stackname,aws-stack-name'));

      vpc.s3Endpoint();

      cidrBlock = cidrBlock.replace(/\/[0-9]+$/g, '/'+numBitsPublic);

      // Create the public subnets
      var letters = zoneLettersPerRegion(region);
      for (i = 0; i < numAzs && letters.length > 0; i += 1) {

        // Public subnet
        letter = letters.shift();

        var subnetPublic = vpc.publicSubnet('Subnet'+letter.toUpperCase()+'public', letter);

        subnetPublic.cidrBlock(cidrBlock);
        subnetPublic.mapPublicIpOnLaunch();

        // If we have more public subnets to create, bump the cidr
        if (i < numAzs && letters.length > 0) {
          cidrBlock = helpers.nextCidrBlockOfSize(cidrBlock, numBitsPublic);
        }
      }

      // Create the first private subnet
      if (numSubnetsPerAz > 1) {
        letters = zoneLettersPerRegion(region);
        for (i = 0; i < numAzs && letters.length > 0; i += 1) {

          // Public subnet
          letter = letters.shift();

          // Private subnet one
          var subnetPrivate = vpc.privateSubnet('Subnet'+letter.toUpperCase()+'app', letter);

          cidrBlock   = helpers.nextCidrBlockOfSize(cidrBlock, numBitsPrivate);
          subnetPrivate.cidrBlock(cidrBlock);
          subnetPrivate.mapPublicIpOnLaunch(false);
        }
      }

      // Create the second private subnet
      if (numSubnetsPerAz > 2) {
        letters = zoneLettersPerRegion(region);
        for (i = 0; i < numAzs && letters.length > 0; i += 1) {

          // Public subnet
          letter = letters.shift();

          // Private subnet two
          var subnetPrivate2 = vpc.privateSubnet('Subnet'+letter.toUpperCase()+'lambda', letter);

          cidrBlock   = helpers.nextCidrBlockOfSize(cidrBlock, numBitsPrivate2);
          subnetPrivate2.cidrBlock(cidrBlock);
          subnetPrivate2.mapPublicIpOnLaunch(false);
        }
      }

      // ----- Security Groups -----
      var sgWide = vpc.securityGroup('sgWide');

      sgWide.groupDescription('For wide use');
      sgWide.ingress(-1, -1, -1, '10.0.0.0/8');
      sgWide.ingress('tcp', 22, 22, '0.0.0.0/0');
      sgWide.setTag(namespace+':applyToServices', 'all');

      // ----- Peering to the DB vpcs -----
      if (mainDbVpc && mainDbRouteTable) {
        vpc.peeringConnection(sg.octet2(mainDbVpc.CidrBlock), mainDbVpc.VpcId, mainDbRouteTable.RouteTableId);
      }

      if (secondaryDbVpc && secondaryDbRouteTable) {
        vpc.peeringConnection(sg.octet2(secondaryDbVpc.CidrBlock), secondaryDbVpc.VpcId, secondaryDbRouteTable.RouteTableId);
      }

      // ----- IAM Roles for Instances -----
      if (argvGet(argv, 'instance-iam-roles')) {
        var iam = cfJson.iam();

        _.each(jsaws.serviceNames(), function(service) {
          iam.makeInstanceProfile(namespace, service, cfJson);
        });

        // Make an instance-profile that is for the VPC as a whole, not just for one service type
        iam.makeInstanceProfile(namespace, '', cfJson);

        config.Capabilities = ['CAPABILITY_NAMED_IAM'];
      }

      // ----- Finally, get the JSON -----
      config.TemplateBody = cfJson.toJson();
      config.StackName    = argvGet(argv, 'stack-name,stackname,aws-stack-name');

      return next();

    }, function(next) {

      if (argvGet(argv, 'dry-run,dryrun')) {
        return callback(null, _.extend({}, {template: JSON.parse(config.TemplateBody)}));
      }

      return awsCf.createStack(config, function(err, stackResult_) {
        if (err) { return die(err, callback, 'cf.createStack.createStack'); }

        stackResult = stackResult_;
        return next();
      });

    }], function() {

      // Return the result
      return callback(null, _.extend({}, stackResult, {template: JSON.parse(config.TemplateBody)}));

    });
  });

//  return jsVpc.getRouteTables(function(err, routeTables) {
//    var dbRouteTables = sg._reduce(routeTables, {}, function(m, value, key) {
//      return sg.kvSmart(m, deref(value, 'Tags.mario.dbRole'), value);
//    });
//
//    var mainDbRouteTable        = dbRouteTables.main;         // Might be undefined
//    var secondaryDbRouteTable   = dbRouteTables.secondary;    // Might be undefined
//
//    return jsVpc.getVpcs(function(err, vpcs) {
//      var dbVpcs = sg._reduce(vpcs, {}, function(m, value, key) {
//        return sg.kvSmart(m, deref(value, 'Tags.mario.dbRole'), value);
//      });
//
//      var mainDbVpc             = dbVpcs.main;         // Might be undefined
//      var secondaryDbVpc        = dbVpcs.secondary;    // Might be undefined
//
//      var subnet, cidr, numCidrBits = 20;
//      var cfJson  = new awsJsonLib.CloudFormationJson(options);
//      var vpc     = cfJson.vpc();
//
//      vpc.cidrBlock(options.classB);
//      vpc.enableDnsSupport();
//      vpc.enableDnsHostnames();
//
//      // Create endpoint to S3
//      vpc.s3Endpoint();
//
//      // ----- subnetA - for az 'a' -----
//      cidr      = '10.21.0.0/'+numCidrBits;
//      subnet    = addSubnet('SubnetA', 'a', cidr);
//
//      // ----- subnetB - for az 'b' -----
//      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
//      subnet    = addSubnet('SubnetB', 'b', cidr);
//
//      // ----- subnetD - for az 'd' -----
//      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
//      subnet    = addSubnet('SubnetD', 'd', cidr);
//
//      // ----- subnetE - for az 'e' -----
//      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
//      subnet    = addSubnet('SubnetE', 'e', cidr);
//
//
//      // ----- lambdaSubnetA - for az 'a' -----
//      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
//      subnet    = addSubnet('lambdaSubnetA', 'a', cidr);
//
//      // ----- lambdaSubnetB - for az 'b' -----
//      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
//      subnet    = addSubnet('lambdaSubnetB', 'b', cidr);
//
//      // ----- lambdaSubnetD - for az 'd' -----
//      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
//      subnet    = addSubnet('lambdaSubnetD', 'd', cidr);
//
//      // ----- lambdaSubnetE - for az 'e' -----
//      cidr      = dottedIp(ipNumber(lastIpInCidrBlock(subnet.cidr)) + 1)+'/'+numCidrBits;
//      subnet    = addSubnet('lambdaSubnetE', 'e', cidr);
//
//
//      // ----- Security Groups -----
//      var sgWide = vpc.securityGroup('sgWide');
//
//      sgWide.groupDescription('For wide use');
//      sgWide.ingress(-1, -1, -1, '10.0.0.0/8');
//      sgWide.ingress('tcp', 22, 22, '0.0.0.0/0');
//      sgWide.setTag(options.namespace+':applyToServices', 'all');
//
//      // ----- Peering to the DB vpcs -----
//      if (mainDbVpc && mainDbRouteTable) {
//        vpc.peeringConnection(sg.octet2(mainDbVpc.CidrBlock), mainDbVpc.VpcId, mainDbRouteTable.RouteTableId);
//      }
//
//      if (secondaryDbVpc && secondaryDbRouteTable) {
//        vpc.peeringConnection(sg.octet2(secondaryDbVpc.CidrBlock), secondaryDbVpc.VpcId, secondaryDbRouteTable.RouteTableId);
//      }
//
//      config.TemplateBody = cfJson.toJson();
//      config.StackName    = argvGet(argv, 'stack-name,stackname,aws-stack-name');
//
//      if (argvGet(argv, 'dry-run,dryrun')) {
//        return callback(null, _.extend({}, {template: JSON.parse(config.TemplateBody)}));
//      }
//
//      //var stackResult = {}, err;
//      return awsCf.createStack(config, function(err, stackResult) {
//        if (err) { return die(err, callback, 'cf.createStack.createStack'); }
//
//        return callback(null, _.extend({}, stackResult, {template: JSON.parse(config.TemplateBody)}));
//      });
//
//      function addSubnet(name, letter, cidr) {
//        var subnet  = vpc.publicSubnet(name, letter);
//
//        subnet.cidrBlock(cidr);
//        subnet.mapPublicIpOnLaunch();
//
//        return subnet;
//      }
//    });
//  });
};

sg.exportify(module, cf);


function zoneLettersPerRegion(region) {

  if (region === "ap-south-1")             { return ['a', 'b']; }
  if (region === "eu-west-1")              { return ['a', 'b', 'c']; }
  if (region === "ap-southeast-1")         { return ['a', 'b']; }
  if (region === "ap-southeast-2")         { return ['a', 'b', 'c']; }
  if (region === "eu-central-1")           { return ['a', 'b']; }
  if (region === "ap-northeast-2")         { return ['a', 'c']; }
  if (region === "ap-northeast-1")         { return ['a', 'c']; }
  if (region === "us-east-1")              { return ['a', 'b', 'd', 'e']; }
  if (region === "sa-east-1")              { return ['a', 'b', 'c']; }
  if (region === "us-west-1")              { return ['a', 'b']; }
  if (region === "us-west-2")              { return ['a', 'b', 'c']; }

  // Unknown region. Most have a and b
  return ['a', 'b'];
}

