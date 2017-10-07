
/**
 *  The js-aws version of the AWS CloudFormation API.
 *
 *  Typical:
 *      ra invoke lib/ec2/cf.js createStack --stack-name=cnb --namespace=serverassist --ns-ex=3 --cidr=10.98.0.0/16 | tee /tmp/vpc-template.json | _print
 *
 *      --num-az=1
 *      --num-subnet=2
 *
 *  To create a stack to be admin for namespace:
 *      ra invoke `fn ~/dev cf\.js$` createStack --stack-name=cnb --namespace=serverassist --ns-ex=3 --cluster --cidr=10.98.0.0/16 | tee /tmp/vpc-template.json | _print
 */
var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var helpers             = require('../helpers');
var awsService          = require('../service/service').awsService;
var awsJsonLib          = require('aws-json');
var libPeering          = require('aws-json/lib/cf/peering-connection');
var libRoute            = require('aws-json/lib/cf/route');
var libEip              = require('aws-json/lib/cf/eip');
var libRoute53          = require('aws-json/lib/cf/route-53');

var raEc2               = ra.require('./ec2', __dirname);
var raVpc               = ra.require('./vpc', __dirname);
var raCf;

var hpNetCidrs          = ['15.0.0.0/10', '15.64.0.0/11', '15.96.0.0/13', '66.27.48.0/24'];
var adminHomeCidrs      = ['98.176.47.44/32', '75.80.144.135/32'];
var extCidrs            = hpNetCidrs.concat(adminHomeCidrs);

var AwsJson             = awsJsonLib.AwsJson;
var argvGet             = sg.argvGet;
var deref               = sg.deref;
var die                 = sg.die;
var lastIpInCidrBlock   = sg.lastIpInCidrBlock;
var ipNumber            = sg.ipNumber;
var dottedIp            = sg.dottedIp;
var toCapitalCase       = helpers.toCapitalCase;

var libCf = {};

// TODO: get this from jsaws, like Ec2 does
//var awsCf = new aws.CloudFormation({region: 'us-east-1'});


/**
 *  Create a Cloud Formation stack.
 */
libCf.createStack = function(argv, context, callback) {
  var config = {}, message = '';

  var mainDbRouteTable, secondaryDbRouteTable,  adminRouteTable,  testRouteTable;
  var mainDbVpc,        secondaryDbVpc,         adminVpc,         testVpc,            prodVpc;
  var adminPeering,                                               testPeering;
  var cfJson,           stackResult;
  var vpc;

  var region          = argv.region             || argv.r                 || 'us-east-1';
  var cidrBlock       = argv.cidr_block         || argv.cidr              || '10.199.0.0/16';
  var numAzs          = argv.num_azs            || argv.num_az            || 4;
  var numSubnetsPerAz = argv.num_subnets_per_az || argv.num_subnets       || 3;
  var numBitsPublic   = argv.num_bits_public    || argv.public_size       || 22;
  var numBitsPrivate  = argv.num_bits_private   || argv.private_size      || 20;
  var numBitsPrivate2 = argv.num_bits_private2  || argv.private2_size     || 20;
  var roleSessionName = argvGet(argv, 'role_session_name,session') || 'main';
  var acct            = argvGet(argv, 'account,acct');
  var role            = argvGet(argv, 'role');

  var namespace       = argv.namespace                                    || 'jsaws';
  var isCluster       = argv.cluster;
  var isTest          = argv.test;

  var stackNameEx     = argvGet(argv, 'stack-name,stackname,aws-stack-name');
  var instanceRoles   = argvGet(argv, 'instance-iam-roles');
  var skipPeering     = argvGet(argv, 'no-peering-vpcs,skip-peering');
  var skipTestPeering = argvGet(argv, 'no-peering-test-vpcs,skip-peering');

  var namespaceNum    = (argvGet(argv, 'namespace-ex,ns-ex,ns2') || '');
  var namespaceEx     = namespace + namespaceNum;
  var stackName       = stackNameEx.replace(/-[0-9]+$/, '');
  var stackNameParts  = stackName.split('-');
  var subDomain       = _.rest(stackNameParts).join('-');

  // The AWS  service
  var awsCf           = awsService('CloudFormation', roleSessionName, acct, role, region);

  var myTag           = awsJsonLib.mkNamespaceTagFn(namespaceEx);
  var serverassistTag = awsJsonLib.mkNamespaceTagFn('serverassist');

  var hostedZone      = argvGet(argv, 'hosted-zone,zone');
  var domainName      = argvGet(argv, 'domain-name,domain') || 'mobilewebprint.net';

  if (!subDomain.match(/^pub/i) && !subDomain.match(/^prod/i)) {
    domainName        = domainName.replace(/web/ig, 'dev');
  }

//  var domainName      = "mobiledevprint.net";
//
//  if (subDomain.match(/^pub/i)) {
//    domainName        = "mobilewebprint.net";
//  }

  var fqdn            = [subDomain, domainName].join('.');

  if (+numSubnetsPerAz === 1) {
    numBitsPublic = Math.min(+numBitsPublic, 19);
  }

  if (argv.classb && !(argv.cidr_block || argv.cidr)) {
    cidrBlock         = '10.999.0.0/16'.replace('999', argv.classb);
  }

  // is this a cluster VPC (aka admin)?
  if (isCluster) {
    instanceRoles     = true;
    skipPeering       = true;
    skipTestPeering   = true;

    message += "Standing up cluster, so no peering, and you have instance-roles.";
  }

  // is this the test (aka qa) stack
  if (isTest) {
    skipTestPeering   = true;

    message += "Standing up test cluster.";
  }

  var routeTables, vpcs, subnets, adminVersion = 1;
  return sg.__runll([function(next) {

    // ----- Get Route Tables -----------------------------------------------------------------------
    //
    //    * Including which one is for the cluster stack (called 'admin' here and below.)
    //    * And which one is for the test stack

    return raVpc.getRouteTables(function(err, routeTables_) {
      routeTables       = routeTables_;
      adminRouteTable   = jsaws.getLatest(routeTables, myTag('admin'));
      testRouteTable    = jsaws.getLatest(routeTables, myTag('test'));

      if (isCluster && adminRouteTable && deref(adminRouteTable, myTag('admin'))) {
        adminVersion = Math.max(adminVersion, deref(adminRouteTable, myTag('admin')) + 1);
      }

      return next();
    });

  }, function(next) {

    // ----- Get VPCs -------------------------------------------------------------------------------
    //
    //    * Including which one is for the cluster stack (called 'admin' here and below.)
    //    * And which one is for the test stack

    return raVpc.getVpcs(function(err, vpcs_) {
      vpcs = vpcs_;
      adminVpc              = jsaws.getLatest(vpcs, myTag('admin'));
      testVpc               = jsaws.getLatest(vpcs, myTag('test'));

      if (isCluster && adminVpc && deref(adminVpc, myTag('admin'))) {
        adminVersion = Math.max(adminVersion, deref(adminVpc, myTag('admin')) + 1);
      }

      return next();
    });

  }, function(next) {

    // ----- Get the Prod VPC -----------------------------------------------------------------------
    //

    getVpcArgv          = jsaws.getAcct('pub', process.env.JSAWS_AWS_ACCT_EXTRA_CREDS);
    getVpcArgv.session  = 'prod';

    return raVpc.getVpcs(getVpcArgv, {}, function(err, vpcs_) {

      _.each(vpcs_, function(vpc, vpcId) {
        var stackName = deref(vpc, ['tags', 'aws:cloudformation:stack-name']);
        if (stackName && stackName.startsWith(namespace)) {
          prodVpc = vpc;
        }
      });

      return next();
    });

  }, function(next) {

    // ----- Get Subnets ----------------------------------------------------------------------------
    //

    return raVpc.getSubnets(function(err, subnets_) {
      subnets = subnets_;
      return next();
    });

  }], function() {

    // ----- Build the js-aws... --------------------------------------------------------------------
    //
    //  ... object that will build the stack.
    //

    return sg.__run([function(next) {

      var i, letter, peeringOptions = {}, peeredVpcs = {};

      // ----- Building up the js-aws object -- mostly network-level stuff here -----

      var cfjsonArgs  = _.extend(sg.deepCopy(argv), {
        description : 'JS-AWS generated stack: "'+argvGet(argv, 'stack-name,stack')+'" (at '+cidrBlock+')'
      });

      cfJson          = new awsJsonLib.CloudFormationJson(cfjsonArgs);
      vpc             = cfJson.vpc();

      vpc.cidrBlock(cidrBlock);
      vpc.enableDnsSupport();
      vpc.enableDnsHostnames();
      vpc.setTag('Name', stackNameEx);

      if (isCluster) {
        vpc.setTag(namespaceEx+":admin", adminVersion || 2);
      }

      // Must be before the creation of subnets, so they can route to it
      vpc.s3Endpoint();

      // Until this point, `cidrBlock` is for the whole VPC; from here on, it tracks the subnet that is being built
      cidrBlock = cidrBlock.replace(/\/[0-9]+$/g, '/'+numBitsPublic);

      //
      //  We create N subnets per AZ (N is set by numSubnetsPerAz, and --num-azs=N)
      //
      //    * We always create one public subnet
      //    * Others are private
      //

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

      // ----- Peering to the admin vpc -----
      if (!skipPeering) {

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
              vpc.peerRoute(routeName, routeTable.RouteTableId, adminPeering, vpc.cidr);
            }
          });

          // Remember that we have peered to this VPC
          peeredVpcs[adminVpc.VpcId] = adminVpc;
        }
      }

      // ----- Peering to the test vpc -----
      if (!skipTestPeering) {

        if (testVpc && testRouteTable && !(testVpc.VpcId in peeredVpcs)) {
          testPeering     = vpc.peeringConnection(sg.octet2(testVpc.CidrBlock), testVpc.VpcId, testRouteTable.RouteTableId);
          peeringOptions  = {peeringConnection: testPeering, peerCidrBlock: testVpc.CidrBlock};

          _.each(routeTables, function(routeTable) {
            var routeName = routeTable.Tags['aws:cloudformation:logical-id'];
            if (routeTable.VpcId === testVpc.VpcId && hasNatRoute(routeTable)) {
              if (!routeName) {
                console.error("Error: Trying to peer test route to us. RouteTable without CloudFormation name: ", routeTable.RouteTableId);
              }

              routeName = routeName +getClassB(testVpc.CidrBlock)+"PeerTo"+getClassB(vpc.cidr);
              vpc.peerRoute(routeName, routeTable.RouteTableId, testPeering, vpc.cidr);
            }
          });

          // Remember that we have peered to this VPC
          peeredVpcs[testVpc.VpcId] = testVpc;
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
          var subnetPrivate2 = vpc.privateSubnet('Subnet'+dLetter(letter)+'Lambda', letter, peeringOptions);

          cidrBlock   = helpers.nextCidrBlockOfSize(cidrBlock, numBitsPrivate2);
          subnetPrivate2.cidrBlock(cidrBlock);
          subnetPrivate2.mapPublicIpOnLaunch(false);
        }
      }

      // ----- Tag the admin public route table -----
      if (isCluster && vpc.publicRouteTable) {
        vpc.publicRouteTable.setTag(namespaceEx+":admin", adminVersion || 2);
      }

      // ----- Tag the test public route table -----
      if (isTest && vpc.publicRouteTable) {
        vpc.publicRouteTable.setTag(namespaceEx+":test", adminVersion || 2);
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
      sgWeb.setTag(namespace+':applyToServices', 'web,admin,bastion');

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

//      // ----- SimpleDb for Stack (and/or Cluster) -----
//      if (!argvGet(argv, 'skip-simple-db')) {
//        var simpleDb = cfJson.simpleDb();
//        simpleDb.makeSimpleDb(toCapitalCase(stackName)+'StackDomain', cfJson, 'Statistics and config for the '+stackNameEx+' stack');
//        if (isCluster) {
//          simpleDb.makeSimpleDb(toCapitalCase(namespaceEx)+'ClusterDomain', cfJson, 'Statistics and config for the '+namespaceEx+' cluster');
//        }
//      }

      // ----- SNS Topics -----
      if (!argvGet(argv, 'skip-sns')) {
        var sns = cfJson.sns();

        var criticalTopic           = sns.makeTopic(toCapitalCase(stackName)+'CriticalErrorsTopic', cfJson, 'Critical Errors for '+stackNameEx);
        var warningTopic            = sns.makeTopic(toCapitalCase(stackName)+'WarningsTopic', cfJson, 'Warnings for '+stackNameEx);

        var stackLifecycleTopic     = sns.makeTopic(toCapitalCase(stackName)+'StackLifecycleTopic', cfJson, 'Stack Lifecycle Events for '+stackNameEx);
        var instanceLifecycleTopic  = sns.makeTopic(toCapitalCase(stackName)+'InstanceLifecycleTopic', cfJson, 'Instance Lifecycle Events for '+stackNameEx);

//        var policy          = sns.makeTopicPolicy(name+'Policy', cfJson, criticalTopic, {policy: 'document'});
//        topic.addSubscription('protocol', 'endpopint');
      }

      // ----- SQS for Work Items -----
      if (!argvGet(argv, 'skip-sqs')) {
        var sqs             = cfJson.sqs();

        var highQueue       = sqs.makeQueue(toCapitalCase(stackName)+'HighWorkQueue', cfJson);
        var workQueue       = sqs.makeQueue(toCapitalCase(stackName)+'WorkQueue', cfJson);
        var lowQueue        = sqs.makeQueue(toCapitalCase(stackName)+'LowWorkQueue', cfJson);
//        var policy          = sqs.makeQueuePolicy(name+'Policy', cfJson, queue, {policy: 'document'});
      }

      // ----- Elastic IPs and Route53 -----
      if (!argvGet(argv, 'skip-eip,skip-eips')) {
        // Need these EIPs: normal, green, blue, teal
//        var mainFqdnEip    = libEip.makeEip(toCapitalCase(stackName)+'Eip', cfJson);
        var greenFqdnEip   = libEip.makeEip(toCapitalCase(stackName)+'GreenEip', cfJson);
        var blueFqdnEip    = libEip.makeEip(toCapitalCase(stackName)+'BlueEip', cfJson);
        var tealFqdnEip    = libEip.makeEip(toCapitalCase(stackName)+'TealEip', cfJson);
        var yellowFqdnEip  = libEip.makeEip(toCapitalCase(stackName)+'YellowEip', cfJson);

        // Hook up Route53 entries to the new EIPs
        var hostedZoneId  =  hostedZone || ((domainName === 'mobilewebprint.net') ? 'Z1S48UHMLLVPYD' : 'Z1B7V290781MX3');
//        var mainFqdnRs    =  libRoute53.makeRecordSetGroup(toCapitalCase(stackName)+'RecordSet',      cfJson, hostedZoneId);
        var greenFqdnRs   =  libRoute53.makeRecordSetGroup(toCapitalCase(stackName)+'GreenRecordSet', cfJson, hostedZoneId);
        var blueFqdnRs    =  libRoute53.makeRecordSetGroup(toCapitalCase(stackName)+'BlueRecordSet',  cfJson, hostedZoneId);
        var tealFqdnRs    =  libRoute53.makeRecordSetGroup(toCapitalCase(stackName)+'TealRecordSet',  cfJson, hostedZoneId);
        var yellowFqdnRs  =  libRoute53.makeRecordSetGroup(toCapitalCase(stackName)+'YellowRecordSet',  cfJson, hostedZoneId);

//        mainFqdnRs.addRecordSet(new    libRoute53.RecordSet(         fqdn,  {A : mainFqdnEip}));
        greenFqdnRs.addRecordSet(new   libRoute53.RecordSet('green-'+fqdn,  {A : greenFqdnEip}));
        blueFqdnRs.addRecordSet(new    libRoute53.RecordSet('blue-'+fqdn,   {A : blueFqdnEip}));
        tealFqdnRs.addRecordSet(new    libRoute53.RecordSet('teal-'+fqdn,   {A : tealFqdnEip}));
        yellowFqdnRs.addRecordSet(new  libRoute53.RecordSet('yellow-'+fqdn, {A : yellowFqdnEip}));
      }

      // Set the command line as an output
      var cmdLineArgs = process.argv.join(' ');
      cfJson.setOutput('cmdline', cmdLineArgs);
      console.error(cmdLineArgs);

      // ----- Finally, get the JSON -----
      config.TemplateBody = cfJson.toJson();
      config.StackName    = stackNameEx;

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

    }, function(next) {

      // Does the user want us to wait for cloud-formation to finish?
      if (!argvGet(argv, 'wait')) { return next(); }

      /* otherwise -- wait until the stack is up and running */
      var waitParams = _.extend({}, argv, {
        stackName:  stackNameEx
      });

      return libCf.waitForStack(waitParams, context, function(err) {
        if (err) { return die(err, callback, 'libCf.createStack.resource-failed'); }

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
  var config            = {};

  var from              = argvGet(argv, 'from');
  var to                = argvGet(argv, 'to');
  var toPcx             = argvGet(argv, 'to-pcx,pcx');
  var toCidr            = argvGet(argv, 'to-cidr');
  var roleSessionName   = argvGet(argv, 'role_session_name,session') || 'main';
  var acct              = argvGet(argv, 'account,acct');
  var role              = argvGet(argv, 'role');
  var region            = argvGet(argv, 'region');

  // The AWS  service
  var awsCf             = awsService('CloudFormation', roleSessionName, acct, role, region);

  if (!from)                  { return die("Need ARGV.from", callback, 'libCf.peerVpcs'); }
  if (!to) {
    if (!toPcx || !toCidr)    { return die("Need ARGV.to or .toPcx-and-.toCidr", callback, 'libCf.peerVpcs'); }
  }

  return raVpc.getVpcs(argv, context, function(err, vpcs) {
    if (err) { return die(err, callback, 'libCf.peerVpcs.getVpcs'); }

    return raVpc.getRouteTables(argv, context, function(err, routeTables) {
      if (err) { return die(err, callback, 'libCf.peerVpcs.getRouteTables'); }

      // We always have a fromVpc, so handle that one first

      // Loop over the VPCs and find the 2 that we need
      var fromVpc, toVpc, name, peering, templateBody, toCidrBlock;
      _.each(vpcs, function(vpc) {
        if (getClassB(vpc.CidrBlock) === from) { fromVpc = vpc; }
        if (getClassB(vpc.CidrBlock) === to)   { toVpc   = vpc; }
      });

      if (!fromVpc)       { return die("Cannot find VPC "+from, callback, 'libCf.peerVpcs'); }
      if (to && !toVpc)   { return die("Cannot find VPC "+to,   callback, 'libCf.peerVpcs'); }

      if (to) {
        toCidrBlock       = toVpc.CidrBlock;
        name              = "PeeringVpc"+from+"To"+to;
      } else {
        toCidrBlock       = toCidr;
        name              = "PeeringVpc"+from+"To"+getClassB(toCidr);
        peering           = toPcx;
      }

      argv.description    = argv.description || "JS-AWS generated peering between "+fromVpc.CidrBlock+" and "+toCidrBlock;

      var cfJson          = new awsJsonLib.CloudFormationJson(argv);

      if (to) {
        peering           = libPeering.makePeeringConnection(name, cfJson, fromVpc.VpcId, toVpc.VpcId);
      }

      // Now loop over the route tables, and find which are for our VPCs
      _.each(routeTables, function(routeTable) {
        var peerRoute;
        var routeName = routeTable.Tags['aws:cloudformation:logical-id'];

        if (!routeName) {
          //console.error("Error: Trying to peer admin route to us. RouteTable without CloudFormation name: ", routeTable.RouteTableId, routeTable);
          return;
        }

        // Is this the from-vpc?
        if (routeTable.VpcId === fromVpc.VpcId /* && hasNatRoute(routeTable) */ ) {

          routeName   = routeName +getClassB(fromVpc.CidrBlock)+"PeerTo"+getClassB(toCidrBlock);
          peerRoute   = libRoute.makeRoute(routeName, cfJson, routeTable.RouteTableId, {peeringConnection: peering});
          peerRoute.destinationCidrBlock(toCidrBlock);
        }

        // Is this the to-vpc?
        if (toVpc && (routeTable.VpcId === toVpc.VpcId) /* && hasNatRoute(routeTable) */ ) {

          routeName   = routeName +getClassB(toVpc.CidrBlock)+"PeerTo"+getClassB(fromVpc.CidrBlock);
          peerRoute   = libRoute.makeRoute(routeName, cfJson, routeTable.RouteTableId, {peeringConnection: peering});
          peerRoute.destinationCidrBlock(fromVpc.CidrBlock);
        }
      });

      // Set the command line as an output
      var cmdLineArgs = process.argv.join(' ');
      cfJson.setOutput('cmdline', cmdLineArgs);

      config.TemplateBody = cfJson.toJson();
      config.StackName    = "peering-between-"+from+"-and-"+getClassB(toCidrBlock);

      if (argvGet(argv, 'dry-run,dryrun')) {
        return callback(null, _.extend({}, {name: config.StackName, template: JSON.parse(config.TemplateBody)}));
      }

      return awsCf.createStack(config, function(err, stackResult) {
        if (err) { return die(err, callback, 'libCf.peerVpcs.createStack'); }

        // Does the user want us to wait for cloud-formation to finish?
        if (!argvGet(argv, 'wait')) { return callback(null, stackResult); }

        /* otherwise -- wait until the stack is up and running */
        var waitParams = _.extend({}, argv, {
          stackName: config.StackName
        });

        return libCf.waitForStack(waitParams, context, function(err) {
          if (err) { return die(err, callback, 'libCf.peerVpcs.resource-failed'); }

          return callback(null, stackResult);
        });
      });
    });
  });
};

libCf.waitForStack = function(argv, context, callback) {

  var awsCf = argv.awsCf;
  if (!awsCf) {
    var roleSessionName = argvGet(argv, 'role_session_name,session') || 'main';
    var acct            = argvGet(argv, 'account,acct');
    var role            = argvGet(argv, 'role');
    var region          = argvGet(argv, 'region');

    // The AWS  service
    awsCf               = awsService('CloudFormation', roleSessionName, acct, role, region);
  }

  var hasFailure = false, nextToken, delayMsec = 5000;
  var startTimeNoMoreOutstanding;

  // Run until cloud-formation is done
  return sg.until(function(again, last, count, elapsed) {

    var totalCount = 0, numInProgress = 0, numComplete = 0;
    var params = {
      StackName: argv.stackName
    };

    // Run until we get complete results -- AWS will only send a sub-set, if there are a lot of resources
    return sg.until(function(again, last, count) {

      // Call AWS list-stack-resources
      return awsCf.listStackResources(params, function(err, data) {

        // Check results - but try again on errors
        if (err)    { console.error(err); return again(delayMsec); }
        if (!data)  { return again(delayMsec); }

        // Running count of all of the resources for this request
        totalCount += data.StackResourceSummaries.length;
        if (totalCount === 0)              { return again(delayMsec); }

        // Look at all of the resources
        _.each(data.StackResourceSummaries, function(resource) {
//            console.log('CF resource:', resource);

          if (resource.ResourceStatus.match(/IN_PROGRESS$/))   { numInProgress += 1; }
          if (resource.ResourceStatus.match(/COMPLETE$/))      { numComplete   += 1; }

          if (resource.ResourceStatus.match(/FAILED$/)) {
            hasFailure = resource;
            console.error('CF Resource failed:', resource.ResourceStatusReason, resource);
          }
        });

        // Report
        console.error("Remaining resources: ", numInProgress, "(num complete: ", numComplete, ") / of total:", totalCount, "msec:", elapsed);

        // When there are only a few left, show them
        if (numInProgress <= 5) {
          _.each(data.StackResourceSummaries, function(resource) {
            if (resource.ResourceStatus.match(/IN_PROGRESS$/)) {
              console.error('still working on', resource.ResourceType, resource.LogicalResourceId, resource.ResourceStatusReason);
            }
          });
        }

        // Bail on a failure
        if (hasFailure) {
          return die(hasFailure, callback, 'libCf.createStack.resource-failed');
        }

        // If there is a nextToken, we have to fetch more data
        if (data.NextToken) {
          params.NextToken = data.NextToken;
          return again();
        }

        /* otherwise -- we have all of the data for this request */
        return last();
      });

    }, function() {
      // We have received all of the data for this request -- no more nextTokens

      if (totalCount == 0 || numInProgress > 0) {
        // Not done, go around again
        startTimeNoMoreOutstanding = null;
        return again(delayMsec);
      }

      // Sometimes, we get to zero, and CF adds more
      startTimeNoMoreOutstanding = startTimeNoMoreOutstanding || Date.now();
      if (Date.now() - startTimeNoMoreOutstanding < 45000) {
        console.error("CF at zero, waiting, tho------------------");
        return again(delayMsec);
      }

      // Wow, we must finally be done
      console.error("CF is done!----------------------------------");
      return last();

    });
  }, function() {
    return callback();
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
  //if (region === "us-east-1")              { return ['a', 'b', 'c', 'e']; }
  if (region === "us-east-1")              { return ['a', 'b', 'd', 'e']; }
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

