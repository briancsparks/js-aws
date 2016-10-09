
/**
 *  The js-aws version of the AWS CloudFormation API.
 *
 *  Typical:
 *      ra invoke lib/ec2/cf.js createStack --stack-name=toad-cnb-03 --namespace=toad --cidr=10.98.0.0/16 | tee /tmp/vpc-template.json | _print
 *
 *  To create roles:
 *      ra invoke lib/ec2/cf.js createStack --stack-name=toad-cnb-03 --namespace=toad --instance-iam-roles --cidr=10.98.0.0/16 | tee /tmp/vpc-template.json | _print
 */
var sg                  = require('sgsg');
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var helpers             = require('../helpers');
var awsJsonLib          = require('aws-json');

var raVpc               = ra.require('./vpc', __dirname);
var raCf;

var AwsJson             = awsJsonLib.AwsJson;
var _                   = sg._;
var argvGet             = sg.argvGet;
var deref               = sg.deref;
var die                 = sg.die;
var lastIpInCidrBlock   = sg.lastIpInCidrBlock;
var ipNumber            = sg.ipNumber;
var dottedIp            = sg.dottedIp;
var toCapitalCase       = helpers.toCapitalCase;

var libCf = {};

// TODO: get this from jsaws, like Ec2 does
var awsCf = new aws.CloudFormation({region: 'us-east-1'});

/**
 *  Create a Cloud Formation stack.
 */
libCf.createStack = function(argv, context, callback) {
  var config = {};

  var mainDbRouteTable, secondaryDbRouteTable,  adminRouteTable;
  var mainDbVpc,        secondaryDbVpc,         adminVpc;
  var adminPeering;
  var cfJson,           stackResult;
  var vpc;

  var region          = argv.region             || argv.r                 || 'us-east-1';
  var cidrBlock       = argv.cidr_block         || argv.cidr              || '10.199.0.0/16';
  var numBitsPublic   = argv.num_bits_public    || argv.public_size       || 22;
  var numBitsPrivate  = argv.num_bits_private   || argv.private_size      || 20;
  var numBitsPrivate2 = argv.num_bits_private2  || argv.private2_size     || 20;
  var numAzs          = argv.num_azs            || argv.num_az            || 4;
  var numSubnetsPerAz = argv.num_subnets_per_az || argv.num_subnets       || 3;
  var namespace       = argv.namespace                                    || 'jsaws';

  var stackName       = argvGet(argv, 'stack-name,stackname,aws-stack-name');

  var myTag           = awsJsonLib.mkNamespaceTagFn(namespace);
  var marioTag        = awsJsonLib.mkNamespaceTagFn('mario');

  if (argv.classb && !(argv.cidr_block || argv.cidr)) {
    cidrBlock         = '10.999.0.0/16'.replace('999', argv.classb);
  }

  return sg.__runll([function(next) {
    return raVpc.getRouteTables(function(err, routeTables) {
      var dbRouteTables = sg._reduce(routeTables, {}, function(m, value, key) {
        return sg.kvSmart(m, deref(value, myTag('dbRole')) || deref(value, marioTag('dbRole')), value);
      });

      mainDbRouteTable        = dbRouteTables.main;         // Might be undefined
      secondaryDbRouteTable   = dbRouteTables.secondary;    // Might be undefined

      adminRouteTable         = jsaws.getLatest(routeTables, myTag('admin')) || jsaws.getLatest(routeTables, marioTag('admin'));

      return next();
    });

  }, function(next) {
    return raVpc.getVpcs(function(err, vpcs) {
      var dbVpcs = sg._reduce(vpcs, {}, function(m, value, key) {
        return sg.kvSmart(m, deref(value, myTag('dbRole')) || deref(value, marioTag('dbRole')), value);
      });

      mainDbVpc             = dbVpcs.main;         // Might be undefined
      secondaryDbVpc        = dbVpcs.secondary;    // Might be undefined

      adminVpc              = jsaws.getLatest(vpcs, myTag('admin')) || jsaws.getLatest(vpcs, marioTag('admin'));

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
      vpc.setTag('Name', stackName);

      vpc.s3Endpoint();

      cidrBlock = cidrBlock.replace(/\/[0-9]+$/g, '/'+numBitsPublic);

      // ----- Create the public subnets -----
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

      // ----- Peering to the admin and DB vpcs -----
      var peeringOptions = {}, peeredVpcs = {};
      if (adminVpc && adminRouteTable && !(adminVpc.VpcId in peeredVpcs)) {
        adminPeering    = vpc.peeringConnection(sg.octet2(adminVpc.CidrBlock), adminVpc.VpcId, adminRouteTable.RouteTableId);
        peeringOptions  = {peeringConnection: adminPeering, peerCidrBlock: adminVpc.CidrBlock};

        peeredVpcs[adminVpc.VpcId] = true;
      }

      if (mainDbVpc && mainDbRouteTable && !(mainDbVpc.VpcId in peeredVpcs)) {
        vpc.peeringConnection(sg.octet2(mainDbVpc.CidrBlock), mainDbVpc.VpcId, mainDbRouteTable.RouteTableId);
        peeredVpcs[mainDbVpc.VpcId] = true;
      }

      if (secondaryDbVpc && secondaryDbRouteTable && !(secondaryDbVpc.VpcId in peeredVpcs)) {
        vpc.peeringConnection(sg.octet2(secondaryDbVpc.CidrBlock), secondaryDbVpc.VpcId, secondaryDbRouteTable.RouteTableId);
        peeredVpcs[secondaryDbVpc.VpcId] = true;
      }

      // ----- Create the first private subnet -----
      if (numSubnetsPerAz > 1) {
        letters = zoneLettersPerRegion(region);
        for (i = 0; i < numAzs && letters.length > 0; i += 1) {

          // Public subnet
          letter = letters.shift();

          // Private subnet one
          var subnetPrivate = vpc.privateSubnet('Subnet'+letter.toUpperCase()+'app', letter, peeringOptions);

          cidrBlock   = helpers.nextCidrBlockOfSize(cidrBlock, numBitsPrivate);
          subnetPrivate.cidrBlock(cidrBlock);
          subnetPrivate.mapPublicIpOnLaunch(false);
        }
      }

      // ----- Create the second private subnet -----
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

      // ----- SimpleDb for Cluster -----
      var simpleDb = cfJson.simpleDb();
      simpleDb.makeSimpleDb('ClusterDomain', cfJson, 'Statistics and config for the '+stackName+' cluster');

      // ----- SNS Topic for Critical Notifications -----
      var sns = cfJson.sns();

      var topic           = sns.makeTopic(toCapitalCase(stackName)+'CriticalErrorsTopic', cfJson, 'Critical Errors for '+stackName);
//      var policy          = sns.makeTopicPolicy(name+'Policy', cfJson, topic, {policy: 'document'});

//      topic.addSubscription('protocol', 'endpopint');
//
//      // ----- SQS for Work Items -----
//      var sqs             = cfJson.sqs();
//
//      var queue           = sqs.makeQueue(name, cfJson);
//      var policy          = sqs.makeQueuePolicy(name+'Policy', cfJson, queue, {policy: 'document'});

      // ----- Finally, get the JSON -----
      config.TemplateBody = cfJson.toJson();
      config.StackName    = stackName;

      return next();

    }, function(next) {

      if (argvGet(argv, 'dry-run,dryrun')) {
        return callback(null, _.extend({}, {template: JSON.parse(config.TemplateBody)}));
      }

      return awsCf.createStack(config, function(err, stackResult_) {
        if (err) { return die(err, callback, 'libCf.createStack.createStack'); }

        stackResult = stackResult_;
        return next();
      });

    }], function() {

      // Return the result
      return callback(null, _.extend({}, stackResult, {template: JSON.parse(config.TemplateBody)}));

    });
  });
};

raCf = ra.wrap(libCf);
sg.exportify(module, libCf);


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

