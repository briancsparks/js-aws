
/**
 *  The js-aws version of the AWS CloudFormation API.
 *
 *  Typical:
 *      ra invoke lib/ec2/cf.js createStack --stack-name=mario-cnb-03 --namespace=mario --ns-ex=3 --cidr=10.98.0.0/16 | tee /tmp/vpc-template.json | _print
 *
 *      --num-az=1
 *      --num-subnet=2
 *
 *  To create a stack to be admin for namespace:
 *      ra invoke `fn ~/dev cf\.js$` createStack --stack-name=mario-cnb-03 --namespace=mario --ns-ex=3 --cluster --cidr=10.98.0.0/16 | tee /tmp/vpc-template.json | _print
 */
var sg                  = require('sgsg');
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var helpers             = require('../helpers');
var awsJsonLib          = require('aws-json');
var libPeering          = require('aws-json/lib/cf/peering-connection');
var libRoute            = require('aws-json/lib/cf/route');

var raVpc               = ra.require('./vpc', __dirname);
var raCf;

var hpNetCidrs          = ['15.0.0.0/10', '15.64.0.0/11', '15.96.0.0/13', '66.27.48.242/24'];
var adminHomeCidrs      = ['98.176.47.44/32'];
var extCidrs            = hpNetCidrs.concat(adminHomeCidrs);

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
  var config = {}, message = '';

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
  var isCluster       = argv.cluster;

  var stackName       = argvGet(argv, 'stack-name,stackname,aws-stack-name');
  var instanceRoles   = argvGet(argv, 'instance-iam-roles');
  var skipPeering     = argvGet(argv, 'no-peering-vpcs,skip-peering');

  var namespaceEx     = namespace + (argvGet(argv, 'namespace-ex,ns-ex,ns2') || '');

  var myTag           = awsJsonLib.mkNamespaceTagFn(namespaceEx);
  var marioTag        = awsJsonLib.mkNamespaceTagFn('mario');

  if (argv.classb && !(argv.cidr_block || argv.cidr)) {
    cidrBlock         = '10.999.0.0/16'.replace('999', argv.classb);
  }

  // Is this a cluster?
  if (isCluster) {
    instanceRoles = true;
    skipPeering   = true;

    message += "Running cluster, so NO PEERING, and you have INSTANCE-ROLES.";
  }

  var routeTables, vpcs, subnets, adminVersion = 1;
  return sg.__runll([function(next) {
    return raVpc.getRouteTables(function(err, routeTables_) {
      routeTables       = routeTables_;
      adminRouteTable   = jsaws.getLatest(routeTables, myTag('admin'));

      if (isCluster && adminRouteTable && deref(adminRouteTable, myTag('admin'))) {
        adminVersion = Math.max(adminVersion, deref(adminRouteTable, myTag('admin')) + 1);
      }

      return next();
    });

  }, function(next) {
    return raVpc.getVpcs(function(err, vpcs_) {
      vpcs = vpcs_;
      adminVpc              = jsaws.getLatest(vpcs, myTag('admin'));

      if (isCluster && adminVpc && deref(adminVpc, myTag('admin'))) {
        adminVersion = Math.max(adminVersion, deref(adminVpc, myTag('admin')) + 1);
      }

      return next();
    });

  }, function(next) {
    return raVpc.getSubnets(function(err, subnets_) {
      subnets = subnets_;
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

      if (isCluster) {
        vpc.setTag(namespaceEx+":admin", adminVersion || 2);
      }

      // Must be before the creation of subnets, so they can route to it
      vpc.s3Endpoint();

      cidrBlock = cidrBlock.replace(/\/[0-9]+$/g, '/'+numBitsPublic);

      // ----- Create the public subnets -----
      var letters = zoneLettersPerRegion(region);
      for (i = 0; i < numAzs && letters.length > 0; i += 1) {

        // Public subnet
        letter = letters.shift();

        var subnetPublic = vpc.publicSubnet('Subnet'+dLetter(letter)+'Public', letter);

        subnetPublic.cidrBlock(cidrBlock);
        subnetPublic.mapPublicIpOnLaunch();

        // If we have more public subnets to create, bump the cidr
        if (i < numAzs && letters.length > 0) {
          cidrBlock = helpers.nextCidrBlockOfSize(cidrBlock, numBitsPublic);
        }
      }

      // ----- Peering to the admin and DB vpcs -----
      if (!skipPeering) {
        var peeringOptions = {}, peeredVpcs = {};
        if (adminVpc && adminRouteTable && !(adminVpc.VpcId in peeredVpcs)) {
          adminPeering    = vpc.peeringConnection(sg.octet2(adminVpc.CidrBlock), adminVpc.VpcId, adminRouteTable.RouteTableId);
          peeringOptions  = {peeringConnection: adminPeering, peerCidrBlock: adminVpc.CidrBlock};

          _.each(routeTables, function(routeTable) {
            var routeName = routeTable.Tags['aws:cloudformation:logical-id'];
            if (routeTable.VpcId === adminVpc.VpcId && hasNatRoute(routeTable)) {
              if (!routeName) {
                console.error("Error: Trying to peer admin route to us. RouteTable without CloudFormation name: ", routeTable.RouteTableId);
              }

              routeName = routeName +getClassB(adminVpc.CidrBlock)+"PeerTo"+getClassB(vpc.cidr);
              console.error("Peer route: "+routeName);
              vpc.peerRoute(routeName, routeTable.RouteTableId, adminPeering, vpc.cidr);
            }
          });

          peeredVpcs[adminVpc.VpcId] = adminVpc;
        }
      }

      // ----- Create the first private subnet -----
      if (numSubnetsPerAz > 1) {
        letters = zoneLettersPerRegion(region);
        for (i = 0; i < numAzs && letters.length > 0; i += 1) {

          // Public subnet
          letter = letters.shift();

          // Private subnet one
          var subnetPrivate = vpc.privateSubnet('Subnet'+dLetter(letter)+'App', letter, peeringOptions);

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
          var subnetPrivate2 = vpc.privateSubnet('Subnet'+dLetter(letter)+'Lambda', letter);

          cidrBlock   = helpers.nextCidrBlockOfSize(cidrBlock, numBitsPrivate2);
          subnetPrivate2.cidrBlock(cidrBlock);
          subnetPrivate2.mapPublicIpOnLaunch(false);
        }
      }

      // ----- Tag the public route table -----
      if (isCluster && vpc.publicRouteTable) {
        vpc.publicRouteTable.setTag(namespaceEx+":admin", adminVersion || 2);
      }

      // ----- Security Groups -----

      // Wide-access within VPC
      var sgWide = vpc.securityGroup('sgWide');

      sgWide.groupDescription('For wide use');
      sgWide.ingress(-1, -1, -1, '10.0.0.0/8');
      sgWide.ingress('tcp', 22, 22, '10.0.0.0/8');
      sgWide.setTag(namespace+':applyToServices', 'all');

      // Ports for web-tier
      var sgWeb = vpc.securityGroup('sgWeb');

      sgWeb.groupDescription('web-tier');
      sgWeb.setTag(namespace+':applyToServices', 'web,admin');

      sgWeb.ingress('tcp',  80,  80, '0.0.0.0/0');
      sgWeb.ingress('tcp', 443, 443, '0.0.0.0/0');

      _.each(extCidrs, function(cidr) {
        sgWeb.ingress('tcp', 22, 22, cidr);
      });

      // ----- IAM Roles for Instances -----
      if (instanceRoles) {
        var iam = cfJson.iam();

        _.each(jsaws.serviceNames(), function(service) {
          iam.makeInstanceProfile(namespaceEx, service, cfJson);
        });

        // Make an instance-profile that is for the VPC as a whole, not just for one service type
        iam.makeInstanceProfile(namespaceEx, '', cfJson);

        config.Capabilities = ['CAPABILITY_NAMED_IAM'];
      }

      // ----- SimpleDb for Stack (and/or Cluster) -----
      var simpleDb = cfJson.simpleDb();
      simpleDb.makeSimpleDb(toCapitalCase(stackName)+'StackDomain', cfJson, 'Statistics and config for the '+stackName+' stack');
      if (isCluster) {
        simpleDb.makeSimpleDb(toCapitalCase(namespaceEx)+'ClusterDomain', cfJson, 'Statistics and config for the '+namespaceEx+' cluster');
      }

      // ----- SNS Topics -----
      var sns = cfJson.sns();

      var criticalTopic           = sns.makeTopic(toCapitalCase(stackName)+'CriticalErrorsTopic', cfJson, 'Critical Errors for '+stackName);
      var warningTopic            = sns.makeTopic(toCapitalCase(stackName)+'WarningsTopic', cfJson, 'Warnings for '+stackName);

      var stackLifecycleTopic     = sns.makeTopic(toCapitalCase(stackName)+'StackLifecycleTopic', cfJson, 'Stack Lifecycle Events for '+stackName);
      var instanceLifecycleTopic  = sns.makeTopic(toCapitalCase(stackName)+'InstanceLifecycleTopic', cfJson, 'Instance Lifecycle Events for '+stackName);

//      var policy          = sns.makeTopicPolicy(name+'Policy', cfJson, criticalTopic, {policy: 'document'});

//      topic.addSubscription('protocol', 'endpopint');
//
      // ----- SQS for Work Items -----
      var sqs             = cfJson.sqs();

      var highQueue       = sqs.makeQueue(toCapitalCase(stackName)+'HighWorkQueue', cfJson);
      var workQueue       = sqs.makeQueue(toCapitalCase(stackName)+'WorkQueue', cfJson);
      var lowQueue        = sqs.makeQueue(toCapitalCase(stackName)+'LowWorkQueue', cfJson);
//      var policy          = sqs.makeQueuePolicy(name+'Policy', cfJson, queue, {policy: 'document'});

      // Set the command line as an output
      var cmdLineArgs = process.argv.join(' ');
      cfJson.setOutput('cmdline', cmdLineArgs);
      console.error(cmdLineArgs);

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

      if (message) {
        console.error(message);
      }

      // Return the result
      return callback(null, _.extend({}, stackResult, {template: JSON.parse(config.TemplateBody)}));

    });
  });
};

libCf.peerVpcs = function(argv, context, callback) {
  var config = {};

  var from      = argvGet(argv, 'from');
  var to        = argvGet(argv, 'to');

  if (!from)      { return die("Need ARGV.from", callback, 'libCf.peerVpcs'); }
  if (!to)        { return die("Need ARGV.to", callback, 'libCf.peerVpcs'); }

  argv.description = argv.description || "Peering between "+from+" and "+to;

  return raVpc.getVpcs(function(err, vpcs) {
    return raVpc.getRouteTables(function(err, routeTables) {
      if (err) { return die(err, callback, 'libCf.peerVpcs'); }

      // Loop over the VPCs and find the 2 that we need
      var fromVpc, toVpc;
      _.each(vpcs, function(vpc) {
        if (getClassB(vpc.CidrBlock) === from) { fromVpc = vpc; }
        if (getClassB(vpc.CidrBlock) === to)   { toVpc   = vpc; }
      });

      if (!fromVpc)     { return die("Cannot find VPC "+from, callback, 'libCf.peerVpcs'); }
      if (!toVpc)       { return die("Cannot find VPC "+to,   callback, 'libCf.peerVpcs'); }

      // We have the 2 VPCs
      var cfJson        = new awsJsonLib.CloudFormationJson(argv);
      var name          = "PeeringVpc"+from+"To"+to;
      var peering       = libPeering.makePeeringConnection(name, cfJson, fromVpc.VpcId, toVpc.VpcId);
      var templateBody;

      // Now loop over the route tables, and find which are for our VPCs
      _.each(routeTables, function(routeTable) {
        var routeName = routeTable.Tags['aws:cloudformation:logical-id'];

        if (!routeName) {
          //console.error("Error: Trying to peer admin route to us. RouteTable without CloudFormation name: ", routeTable.RouteTableId, routeTable);
          return;
        }

        // Is this the from-vpc?
        if (routeTable.VpcId === fromVpc.VpcId /* && hasNatRoute(routeTable) */ ) {

          routeName = routeName +getClassB(fromVpc.CidrBlock)+"PeerTo"+getClassB(toVpc.CidrBlock);
          console.error("Peer route: "+routeName);
          //vpc.peerRoute(routeName, routeTable.RouteTableId, adminPeering, vpc.cidr);

          var peerRoute = libRoute.makeRoute(routeName, cfJson, routeTable.RouteTableId, {peeringConnection: peering});
          peerRoute.destinationCidrBlock(toVpc.CidrBlock);
        }

        // Is this the to-vpc?
        if (routeTable.VpcId === toVpc.VpcId /* && hasNatRoute(routeTable) */ ) {

          routeName = routeName +getClassB(toVpc.CidrBlock)+"PeerTo"+getClassB(fromVpc.CidrBlock);
          console.error("Peer route: "+routeName);
          //vpc.peerRoute(routeName, routeTable.RouteTableId, adminPeering, vpc.cidr);

          var peerRoute = libRoute.makeRoute(routeName, cfJson, routeTable.RouteTableId, {peeringConnection: peering});
          peerRoute.destinationCidrBlock(fromVpc.CidrBlock);
        }
      });

      // Set the command line as an output
      var cmdLineArgs = process.argv.join(' ');
      cfJson.setOutput('cmdline', cmdLineArgs);

      config.TemplateBody = cfJson.toJson();
      config.StackName    = "peering-between-"+from+"-and-"+to;

      if (argvGet(argv, 'dry-run,dryrun')) {
        return callback(null, _.extend({}, {template: JSON.parse(config.TemplateBody)}));
      }

      return awsCf.createStack(config, function(err, stackResult) {
        if (err) { return die(err, callback, 'libCf.createStack.createStack'); }

        return callback(null, stackResult);
      });
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
  if (region === "us-east-1")              { return ['e', 'd', 'b', 'a']; }
  if (region === "sa-east-1")              { return ['a', 'b', 'c']; }
  if (region === "us-west-1")              { return ['a', 'b']; }
  if (region === "us-west-2")              { return ['a', 'b', 'c']; }

  // Unknown region. Most have a and b
  return ['a', 'b'];
}

function hasNatRoute(routeTable) {
  var hasNat;
  _.each(routeTable.Routes, function(route) {
    if (route.NatGatewayId) {
      hasNat = true;
    }
  });

  return hasNat;
}

function getClassB(cidrBlock) {
  return +cidrBlock.split(/[^0-9]/)[1];
}

function dLetter(letter) {
  return letter.toUpperCase()+letter;
}

