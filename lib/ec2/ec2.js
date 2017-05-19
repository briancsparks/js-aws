
/**
 *  The js-aws version of the AWS EC2 API.
 *
 *  Conforms to the run-anywhere calling convention.
 *
 *  runInstance() -- Launch an instance.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var superagent          = require('superagent');
var ra                  = require('run-anywhere');
var helpers             = require('../helpers');
var path                = require('path');
var util                = require('util');
var awsJsonLib          = require('aws-json');
var awsServiceLib       = require('../service/service');

// run-anywhere-ified modules
var raVpc               = ra.require('./vpc', __dirname);
var raIam               = ra.require('../iam/iam', __dirname);
var raRoute53           = ra.require('../route-53/route-53', __dirname);

var raEc2;                /* Gets build from the libEc2 object at the end of this file */

// Sub-object functions
var getConfig           = jsaws.getConfig;
//var getAll              = jsaws.getAll;
//var getX2               = jsaws.getX2;
var get2X2              = jsaws.get2X2;
var get2X2_2            = jsaws.get2X2_2;
var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;
var firstKey            = sg.firstKey;
var deref               = sg.deref;
var setOn               = sg.setOn;
var setOnn              = sg.setOnn;
var setOnna             = sg.setOnna;
var die                 = sg.die;
var numKeys             = sg.numKeys;
var isInCidrBlock       = helpers.isInCidrBlock;
var addTag              = awsJsonLib.addTag;
var toAwsTags           = awsJsonLib.toAwsTags;
var awsService          = awsServiceLib.awsService;
var extractServiceArgs  = awsServiceLib.extractServiceArgs;

//var log                 = helpers.log;
var format              = util.format;

var libEc2 = {};

// ===================================================================================================
//
//    Functionality
//
// ===================================================================================================

/**
 *  Launch an AWS instance.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 *
 *    ra invoke lib/ec2/ec2.js runInstance --db=10.11.21.220 --util=10.11.21.4 --namespace=mario3 --color=black --build-number=16 --key=mario_demo --instance-type=t2.large --image-id=ami- --ip=10.11.21.119
 *
 *  WordPress:
 *    --db=10.11.21.220 --util=10.11.21.4 --namespace=mario3 --color=black --key=mario_demo --instance-type=c4.xlarge --image-id=ami-46ec9451 --ip=10.11.21.119
 *
 *  Required:
 *    argv.ip
 *    argv.instance_type
 *    argv.key
 *
 *    argv.num_tries  : Try this many times to launch with the IP. If we get InvalidIPAddress.InUse, try with the next IP address.
 *    argv.force_ip   : The opposite of num_tries. Use only this IP.
 *    argv.namespace
 *    argv.tier
 *    argv.service
 *    argv.serviceType
 *    argv.owner_id
 *    argv.environment
 *    argv.test
 *    argv.username
 *    argv.no_wait
 *    argv.region
 *    argv.image_id
 *    argv.min_count
 *    argv.max_count
 *    argv.monitoring
 *    argv.shutdown_behavior
 *    argv.api_termination
 *    argv.placement
 *    argv.zone
 *    argv.dry_run
 *    argv.account
 *    argv.instance_profile
 *    argv.user_data
 */
libEc2.runInstance = function(argv, context, callback, options_) {

  // Did the caller pass in information for a different account?
  var roleSessionName = argvGet(argv, 'role_session_name,session') || 'main';
  var acct            = argvGet(argv, 'account,acct');
  var role            = argvGet(argv, 'role');
  var region          = argvGet(argv, 'region');

  // The AWS EC2 service
  var awsEc2          = awsService('EC2', roleSessionName, acct, role, region);

  var log           = sg.mkLogger(argv);

  var options       = options_ || {};
  var getUserdata   = options.getUserdata || getUserdata0;

  // All the stuff we will figure out in the sg.__run() callbacks
  var ip, stack, instanceName, m;

  // How many times will we try go find a non-used IP address?
  var numTriesLeft      = argvGet(argv, 'num-tries,tries')  || 10;

  // Do we have a forced IP address?
  if ((ip = argvGet(argv, 'force-ip'))) {
    numTriesLeft = 0;
  }

  // Make sure we have a private IP address
  if (!ip && !(ip = argvGet(argv, 'ip'))) { return die('No internal IP address', callback, 'runInstance'); }

  // Get user options
  var buildoutEnvVars   = {};
  var octets            = ip.split('.');
  var namespace         = argvGet(argv, 'namespace')                  || 'jsaws';
  var namespaceEx       = argvGet(argv, 'namespace-ex,ns-ex,ns2');
  var tier              = argvGet(argv, 'tier')                       || getConfig('tierForIp', ip)         || 'app';
  var service           = argvGet(argv, 'service')                    || getConfig('serviceForIp', ip)      || 'app';
  var serviceType       = argvGet(argv, 'serviceType')                || getConfig('serviceTypeForIp', ip)  || 'app';
  var rtDbIp            = argvGet(argv, 'rt-db-ip,rt-db')             || '10.11.21.220';
  var dbIp              = argvGet(argv, 'db-ip,db')                   || '10.10.21.220';
  var utilIp            = argvGet(argv, 'util-ip,util')               || '10.10.21.4';
  var testDbIp          = argvGet(argv, 'test-db-ip,test-db')         || [octets[0], octets[1], octets[2], 220].join('.');
  var testUtilIp        = argvGet(argv, 'test-util-ip,test-util')     || [octets[0], octets[1], octets[2], 4].join('.');
  var username          = argvGet(argv, 'username')                   || 'scotty';
  var origUsername      = argvGet(argv, 'orig-username')              || 'ubuntu';
  var driveSize         = +(argvGet(argv, 'drive,xvdf')               || '100');

  var firstBuildup      = argvGet(argv, 'first-buildup,first');
  var buildNumber       = argvGet(argv, 'build-num,build-number');
  var color             = argvGet(argv, 'color');

  if (!namespaceEx && (m = namespace.match(/^(.*)([0-9]+)$/))) {
    namespaceEx = namespace;
    namespace   = m[1];
  }

  if (!namespaceEx) {
    namespaceEx = namespace;
  }

  var upNamespace       = namespace.toUpperCase().replace(/[0-9]+$/g, '');    /* strip trailing numbers */
  var serviceNum        = 0;

  // Get the default launch configuration (and use the passed-in argv)
  var launchConfig_     = defLaunchConfig(argv);

  // ----- Build up the configuration
  var launchConfig  = sg.deepCopy(launchConfig_);

  // The things that are found
  var vpc, subnet, securityGroups, ownerId, reservations;

  // See if the args provide some of them
  ownerId = argvGet(argv, 'owner-id,owner') || ownerId;

  log('Launching instance');
  return sg.__run([function(next) {

    console.error(sg.inspect({
      ip          : ip,
      service     : service,
      namespace   : namespace,
      tier        : tier,
      serviceType : serviceType,
      build       : buildNumber,
      color       : color,
      rtDb        : rtDbIp,
      db          : dbIp,
      util        : utilIp,
      testDb      : testDbIp,
      testUtil    : testUtilIp
    }));

    // Warn the user of various things, and let them stop the build
    var warned = false, time = 2000;
    if (!argvGet(argv, 'db-ip,db'))       { warned = true; giantWarning("You should provde a DB IP address. Using "+dbIp+"."); }
    if (!argvGet(argv, 'util-ip,util'))   { warned = true; giantWarning("You should provde a Util IP address. Using "+utilIp+"."); }

    if (warned)     { time = 20000; }

    /* otherwise -- stall so the user can read the messages */
    setTimeout(next, time);

  }, function(next) {

    // ----- Get the VPC, given the IP address, and the stack, and compute the instance name.
    return raVpc.vpcsForIp(_.extend({ip:ip}, argv), context, function(err, vpcs) {
      if (err)                    { return die(err, callback, 'runInstance.vpcsForIp'); }
      if (numKeys(vpcs) !== 1)    { return die('Found '+numKeys(vpcs)+' vpcs, needs to be only one.'+JSON.stringify(argv), callback, 'runInstance.vpcsForIp'); }

      vpc           = deref(vpcs, firstKey(vpcs));
      stack         = getConfig('stackForVpc', vpc);

      instanceName  = [namespace, stack, octets[1], service].join('-');

      log(instanceName);
      return next();
    });

  }], function() {

    return sg.__runll([function(next) {

      // ----- Get subnet for this IP
      return raVpc.getSubnets(argv, context, function(err, subnets_) {
        if (err) { return die(err, callback, 'runInstance.getSubnets'); }

        var subnets = _.filter(subnets_, function(subnet, id) {
          return isInCidrBlock(ip, subnet.CidrBlock) && (subnet.VpcId === vpc.VpcId);
        });
        if (numKeys(subnets) !== 1)    { return die('Found '+numKeys(subnets)+' subnets, needs to be only one. For: '+ip, callback, 'runInstance.getSubnets'); }

        subnet = subnets[0];
        log('using subnet', subnet.SubnetId);

        return next();
      });

    }, function(next) {

      // ----- How does this new instance fit in with the already-existing instances?
      return raEc2.getInstances(function(err, instances) {
        // TODO: Handle code: 'RequestLimitExceeded' (See bottom of this file) -- Needs to be an until
        if (err) { return die(err, callback, 'runInstance.getInstances'); }
        var nic, id;

        // Find the ownerId
        for (id in instances) {
          if (!(nic     = deref(instances[id], 'NetworkInterfaces'))) { continue; }
          if (!(nic     = nic[firstKey(nic)]))                        { continue; }

          if ((ownerId = deref(nic, 'OwnerId'))) {
            break;
          }
        }
        log('owner', ownerId);

        // Find the names of the instances - so we can find the right service number
        var names = _.chain(instances).filter(function(instance) {
          return instance.VpcId === vpc.VpcId;
        }).map(function(instance) {
          return deref(instance, 'Tags.Name');
        }).compact().value();
        log('name(s)', names);

        // Try to find the next service number
        return sg.until(function(again, last, count) {
          var name = instanceName + sg.pad(serviceNum, 2);

          if (count >= 99) {
            instanceName = name;
            return last();
          }

          if (names.indexOf(name) === -1) {
            instanceName = name;
            return last();
          }

          // Try again with the next number
          serviceNum += 1;
          return again();
        }, function() {
          log('service number', serviceNum);
          return next();
        });
      });

    }, function(next) {

      // ----- Get the SGs for this VPC -- at least the ones that know where to apply themselves
      return raVpc.getSecurityGroups(argv, context, function(err, securityGroups_) {
        if (err) { return die(err, callback, 'runInstance.getSubnets'); }

        securityGroups = _.filter(securityGroups_, function(securityGroup, id) {
          var applyToServices = deref(securityGroup, "Tags."+namespace+".applyToServices") || deref(securityGroup, "Tags.serverassist.applyToServices");

          if (securityGroup.VpcId !== vpc.VpcId)                                  { return false; }
          if (deref(securityGroup, "Tags."+namespace+".sg") === 'admin')          { return true; }
          if (!applyToServices)                                                   { return false; }
          if (applyToServices === 'all')                                          { return true; }

          return applyToServices.indexOf(service) !== -1;
        });
        log('security Groups', _.pluck(securityGroups, 'GroupId'));

        return next();
      });

    }, function(next) {
      if (!namespace || !service) { return next(); }

      // TODO: fix the hack. Do not force '3' on the end of the namespace
      var iamNs = namespaceEx;
      if (iamNs === 'mario') {
        iamNs += '3';
      }

      return raIam.getInstanceProfileForRole(argv, [iamNs, service, 'instance-role'].join('-'), context, function(err, arn) {
        if (err) {
          if (err.code !== 'NoSuchEntity')    { return die(err, callback, 'runInstance.getInstanceProfile1'+iamNs+'/'+service); }

          // No such instance profile -- use the generic one
          return raIam.getInstanceProfileForRole(argv, [iamNs, '', 'instance-role'].join('-'), context, function(err, arn) {
            if (err)    { return die(err, callback, 'runInstance.getInstanceProfile2'+iamNs+'/'+service); }

            setOn(launchConfig, 'IamInstanceProfile.Arn', arn);
            return next();
          });
        }

        setOn(launchConfig, 'IamInstanceProfile.Arn', arn);
        return next();
      });

    }], function() {

      return sg.__run([function(next) {

        // TODO: Should use sg.until()
        return once();
        function once() {

          // ----- Warnings -----
          if (!ownerId) {
            console.warn('Warning: could not find the owner id.');
          }

          // ----- Network Interface -----
          var nic = {
            DeleteOnTermination   : true,
            Groups                : [],
            DeviceIndex           : 0
          };

          setOn(nic, 'AssociatePublicIpAddress',  deref(subnet, 'MapPublicIpOnLaunch'));
          setOn(nic, 'SubnetId',                  deref(subnet, 'SubnetId'));
          setOn(nic, 'PrivateIpAddress',          ip);

          nic.Groups = _.pluck(securityGroups, 'GroupId');

          launchConfig.NetworkInterfaces                          = [nic];

          // ----- Placement -----
          setOn(launchConfig, 'Placement.Tenancy',            deref(launchConfig, 'Placement.Tenancy')  || 'default');
          setOn(launchConfig, 'Placement.AvailabilityZone',   deref(subnet, 'AvailabilityZone')         || 'us-east-1a');

          // ----- Shutdown -----
          if (sg.startsWith(argvGet(argv, 'environment,env'), 'prod')) {
            setOn(launchConfig, 'InstanceInitiatedShutdownBehavior',  'stop');
            setOn(launchConfig, 'DisableApiTermination',              true);
          } else if (argv.test) {
            setOn(launchConfig, 'InstanceInitiatedShutdownBehavior',  'terminate');
          }

          // ----- Block Devices -----
          launchConfig.BlockDeviceMappings  = [];

          if (firstBuildup) {
            // No additional drives
            launchConfig.BlockDeviceMappings.push(blockDevice('sda1', 32));
            launchConfig.BlockDeviceMappings.push(blockDevice('sdf', driveSize));
          } else if (service === 'db') {
            launchConfig.BlockDeviceMappings.push(blockDevice('sda1', 32));
            launchConfig.BlockDeviceMappings.push(blockDevice('sdf', 300));
            launchConfig.BlockDeviceMappings.push(blockDevice('sdg', 25));
            launchConfig.BlockDeviceMappings.push(blockDevice('sdh', 10));
          } else {
            launchConfig.BlockDeviceMappings.push(blockDevice('sda1', 32));
            launchConfig.BlockDeviceMappings.push(blockDevice('sdf', driveSize));
          }

          // ----- Critical Startup Environment Variables -----
          buildoutEnvVars.NAMESPACE               = namespace;
          buildoutEnvVars[upNamespace+"_SERVICE"] = buildoutEnvVars.MARIO_SERVICE   = service;
          buildoutEnvVars[upNamespace+"_STACK"]   = buildoutEnvVars.MARIO_STACK     = stack;
          buildoutEnvVars[upNamespace+"_TIER"]    = tier;

          if (color)        { buildoutEnvVars[upNamespace+"_COLOR"]           = color; }
          if (buildNumber)  { buildoutEnvVars[upNamespace+"_BUILD"]           = buildNumber; }
          if (dbIp)         { buildoutEnvVars[upNamespace+"_DB_HOSTNAME"]     = dbIp; }
          if (utilIp)       { buildoutEnvVars[upNamespace+"_UTIL_HOSTNAME"]   = utilIp; }

          // The IP for the DB that has run-time info
          if (rtDbIp)       { buildoutEnvVars[upNamespace+"_RT_DB_IP"]        = rtDbIp; }

          if (dbIp)         { buildoutEnvVars[upNamespace+"_DB_IP"]           = dbIp; }
          if (utilIp)       { buildoutEnvVars[upNamespace+"_UTIL_IP"]         = utilIp; }
          if (testDbIp)     { buildoutEnvVars[upNamespace+"_TEST_DB_IP"]      = testDbIp; }
          if (testUtilIp)   { buildoutEnvVars[upNamespace+"_TEST_UTIL_IP"]    = testUtilIp; }

          buildoutEnvVars.MARIO_DB_HOSTNAME = buildoutEnvVars[upNamespace+"_DB_HOSTNAME"];

          launchConfig.UserData                   = getUserdata(username, upNamespace, buildoutEnvVars, origUsername);

          // ----- Other -----
          launchConfig.InstanceType   = launchConfig.InstanceType || 't2.large';
          launchConfig.KeyName        = launchConfig.KeyName      || namespace+'_demo';

          // Launch
          log('done collecting info... trying to launch', launchConfig.InstanceType, ip);
          return awsEc2.runInstances(launchConfig, function(err, reservations_) {
            //console.error("RunInstance:", err, sg.inspect(launchConfig));
            if (err) {

              // if the IP address is already in use, this is not an error
              if (err.code === 'InvalidIPAddress.InUse' && numTriesLeft > 0) {
                if (argvGet(argv, 'prev-ip')) {
                  ip = helpers.prevIp(ip);
                } else {
                  ip = helpers.nextIp(ip);
                }
                numTriesLeft -= 1;
                return once();
              }

              // Log if this is a dry-run
              if (err.code === 'DryRunOperation') {
                log('dry-run', err, launchConfig);
                return callback();
              }

              // OK, this is an error
              console.error("Error - here is the launch config", launchConfig);
              return die(err, callback, 'runInstance.runInstances');
            }

            reservations = reservations_;

            log('launchConfig', launchConfig);
            log('reservations', reservations);
            log('userScript', Buffer.from(launchConfig.UserData, 'base64').toString());

            return next();
          });
        }

      }, function(next) {

        // ----- Tag Instances -----
        var tagRiptype;
        var tagBuildNumber  = buildNumber;
        var diParams        = { ImageIds : [launchConfig.ImageId] };
        return raEc2.getImages(diParams, context, function(err, images) {

          // If the AMI has a build number, use it.
          if (!err && images) {
            _.each(images, function(image) {
              if (image.Tags && image.Tags[namespaceEx] && ('build' in image.Tags[namespaceEx])) {
                tagBuildNumber = +image.Tags[namespaceEx].build;
              }
              if (image.Tags && image.Tags[namespaceEx] && ('riptype' in image.Tags[namespaceEx])) {
                tagRiptype = image.Tags[namespaceEx].riptype;
              }
            });
          }

          var Tags = [{Key:'Name', Value:instanceName}];
          if (namespace) {
            Tags.push({Key:'namespace', Value:namespace});

            if (service)          { Tags.push({Key:[namespace, 'service'].join(':'), Value:service}); }
            if (tagBuildNumber)   { Tags.push({Key:[namespace, 'build'].join(':'),   Value:''+tagBuildNumber}); }
            if (color)            { Tags.push({Key:[namespace, 'color'].join(':'),   Value:color}); }
            if (stack)            { Tags.push({Key:[namespace, 'stack'].join(':'),   Value:stack}); }

            if (service)          { Tags.push({Key:[           'service'].join(':'), Value:service}); }
            if (color)            { Tags.push({Key:[           'color'].join(':'),   Value:color}); }
            if (stack)            { Tags.push({Key:[           'stack'].join(':'),   Value:stack}); }

            // Special tags for RIPs
            if (tagRiptype)       { Tags.push({Key:[namespace, 'riptype'].join(':'), Value:''+tagRiptype}); }
          }

          return raEc2.tagInstances({ids: _.pluck(reservations.Instances, 'InstanceId'), Tags: Tags}, context, function(err, result) {
            return next();
          });
        });
      }], function() {

        // Return now, if the caller does not want to wait for the instance to be running
        if (argvGet(argv, 'no-wait,nowait')) {
          return callback(null, reservations, launchConfig);
        }

        /* otherwise -- wait for it to be running */
        var waitArgv = {
          instanceId  : _.pluck(reservations.Instances, 'InstanceId'),
          state       : 'running'
        };

        return raEc2.waitForInstanceState(_.extend(waitArgv, argv), context, function(err, instances) {
          return callback(null, instances, launchConfig);
        });
      });
    });
  });
};

/**
 *  Launch an instance from an AMI.
 *
 *  At this point, this function just sets the userdata to something basic.
 */
libEc2.runInstanceFromAmi = function(argv, context, callback) {

  var creds         = extractServiceArgs(argv);
  var namespaceEx   = argvGet(argv, 'namespace,ns');
  var namespace     = namespaceEx.replace(/[0-9]+$/, '');

  return libEc2.runInstance(_.extend({}, argv, creds), context, function(err, instances, launchConfig) {
    if (err)          { return die(err, callback, 'runInstanceFromAmi.runInstance'); }
    if (!instances)   { return die('No instances started', callback, 'runInstanceFromAmi.runInstance'); }

    // Was that a web-instance, which might need to be pointed-to by a sub-domain name?
    var instance  = instances[firstKey(instances)];
    var privateIp = instance.PrivateIpAddress;
    var instStats = instanceStats(privateIp);

    if (instance && instance.Tags && instance.Tags[namespace]) {

      var service = instance.Tags[namespace].service  || instStats.service;
      var color   = instance.Tags[namespace].color    || instStats.color;
      var stack   = launchConfig.stack                || instStats.stack;

      if (service !== 'web')  { return callback(null, instances, launchConfig); }

      var params = _.extend({
        instance_id   : instance.InstanceId,
        fqdn          : instStats.fqdn
      }, creds);

      return raEc2.assignFqdnToInstance(params, context, function(err, result) {
        if (err) { console.error(sg.inspect(params)); return die(err, callback, 'runInstanceFromAmi.assignFqdnToInstances'); }
        return callback(err, instances, launchConfig);
      });
    }

    /* otherwise */
    return callback(null, instances, launchConfig);
  }, {getUserdata : getUserdataForAmi});
};

/**
 *  Tag an EC2 resource
 *
 *  See also the pickTags function
 */
libEc2.tagImages = libEc2.tagImage = libEc2.tagInstances = libEc2.tagInstance = libEc2.tagResource = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);

  var Tags = sg.toArray(argv.Tags);

  // argv might have normal JS style tags in the 'tags' attribute
  _.each(argvGet(argv, 'tags,tag'), function(value, key) {
    if (!_.isString(key) || !_.isString(value)) { return; }
    Tags.push({Key:key, Value:value});
  });

  // also count all 'tag-xyz=value' params
  _.each(_.keys(argv), function(param) {
    if (!_.isString(param) || !_.isString(argv[param])) { return; }
    if (param === 'tag' || param === 'tags') { return; }
    if (sg.startsWith(param, 'tag')) {
      Tags.push({Key: param.substr(3).replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]/g, ':'), Value: argv[param]});
    }
  });

  var resources         = sg.toArray(argvGet(argv, 'resources,resource,ids,id'));
  var createTagsParams  = {Resources : resources, Tags : Tags};

  // Tagging might fail, if so, try again
  var ctResult;
  return sg.until(function(again, last, count) {
    if (count > 5) { return last(); }

    return awsEc2.createTags(createTagsParams, function(err, result) {
      if (err) {
        console.error('createTags err', err, 'for', createTagsParams, 'trying again...');
        return again(250 * (count + 1));
      }

      ctResult = result;
      return last();
    });
  }, function() {
    return callback(null, ctResult);
  });
};

/**
 *  Pick the tags out of the object.
 */
var pickTags = libEc2.pickTags = function(x) {
  var result = {};
  _.each(x, function(value, key) {
    if (_.isString(key) && _.isString(value) && /^tag/i.exec(key)) {
      result[key] = value;
    }
  });

  if (x.Tags) {
    result.Tags = _.toArray(x.Tags);
  }

  return result;
};

/**
 *  Wait for the instances to be in the requested state.
 */
libEc2.waitForInstanceState = function(argv, context, callback) {

  var timeout     = (argvGet(argv, 'timeout')   || 90) * 1000;        // 90 seconds

  // Wait until we get success from getInstances, and we are in the right state.
  return sg.until(function(again, last, count, elapsed) {
    if (count > 200 || elapsed > timeout) { return callback('Waited too long for image state.'); }

    return raEc2.isInstanceState(argv, context, function(err, isRunning, instances) {
      if (err || !isRunning) { return again(500); }
      return last(null, instances);
    });
  }, function(err, instances) {
    return callback(err, instances);
  });
};

/**
 *  Is the instance(s) in the given state?
 */
libEc2.isInstanceState = function(argv, context, callback) {
  var log         = sg.mkLogger(argv);

  var instanceId  = argvGet(argv, 'instance-id,id');
  var instanceIds = argvGet(argv, 'instance-ids,ids')   || instanceId;
  var state       = argvGet(argv, 'state')              || 'running';

  if (!_.isArray(instanceIds)) { instanceIds = [instanceIds]; }

  log('waiting for', instanceIds);

  var diParams = _.extend({ InstanceIds : instanceIds }, _.pick(argv, 'session', 'acct', 'account', 'role', 'region'));

  // Get instance state from AWS
  return raEc2.getInstances(diParams, context, function(err, instances) {
    if (err) { return callback(err, false); }

    var all = _.all(instances, function(instance) { return deref(instance, 'State.Name') === state; });

    return callback(null, all, instances);
  });
};

/**
 *  The JS-ification of the EC2 createImage API.
 */
libEc2.createAmi = function(argv, context, callback) {
  var name      = argvGet(argv, 'name');
  var ciParams  = {
    NoReboot      : false,
    InstanceId    : argvGet(argv, 'instance-id'),
    Name          : name,
    Description   : argvGet(argv, 'description')
  };

  var nameParts   = name.split('-');
  var namespace   = nameParts[0];
  var stack       = nameParts[1];
  var buildNumber = sg.smartValue(nameParts[2]);
  var service     = nameParts[3];

  return sg.until(function(again, done, count, elapsed) {

    // 9999 is the end of the road
    if (buildNumber >= 9999) { return die(err, callback, 'createAmi.createImage'); }

    ciParams.Name = name = [namespace, stack, buildNumber, service].join('-');

    // Call the raw, but ra-ified createImage function
    return raEc2.createImage(ciParams, context, function(err, results) {

      if(err) {

        // If we already have an image with that Name...
        if (err.code === 'InvalidAMIName.Duplicate') {
          // ...bump the build number and try again
          buildNumber += 1;
          console.error(ciParams.Name+' is already taken, trying '+buildNumber);
          return again();
        }

        /* otherwise -- its an error */
        return die(err, callback, 'createAmi.createImage');
      }

      return raEc2.waitForImageState(_.extend({imageId:results.ImageId}, argv), context, function(err, images) {

        var tags  = pickTags(argv);
        tags.tags = tags.tags || {};
        tags.tags.Name = name;

        if (namespace) {
          if (buildNumber)    { tags.tags[namespace+':build'] = ''+buildNumber; }
          if (stack)          { tags.tags[namespace+':stack'] = stack; }
        }

        /* otherwise -- tag it */
        var tiParams  = _.extend({id: results.ImageId}, tags);

        return raEc2.tagImage(tiParams, context, function(err, tagResults) {
          return callback(err, images);
        });
      });
    });
  }, function() {
  });
};

/**
 *  Wait for the AMI created image to be in the desired state.
 */
libEc2.waitForImageState = function(argv, context, callback) {
  var imageId         = argvGet(argv, 'image-id,id');
  var state           = argvGet(argv, 'state')      || 'available';
  var timeout         = (argvGet(argv, 'timeout')   || 60) * 1000 * 60;       // 60 minutes
  var noWait          = argvGet(argv, 'no-wait');
  var noWaitInstance  = argvGet(argv, 'no-wait-instance');

  var instanceId      = argvGet(argv, 'instance-id');

  var diParams = {
    ImageIds      : _.isArray(imageId) ? imageId : [imageId]
  };

  if (!instanceId) {
    noWaitInstance = true;
  }

  if (noWait && noWaitInstance) {
    return callback(null);
  }

  var results, images, instances, isRunning;
  return sg.until(function(again, last, count, elapsed) {
    if (elapsed > timeout) { return callback('Waited too long for image state.'); }

    return sg.__runll([function(next) {
      images = null;
      return raEc2.getImages(diParams, context, function(err, images_) {
        if (!err) { images = images_; }
        return next();
      });
    }, function(next) {
      instances = null;
      isRunning = false;
      return raEc2.isInstanceState(argv, context, function(err, isRunning_, instances_) {
        if (!err) {
          instances = instances_;
          isRunning = isRunning_;
        }
        return next();
      });
    }], function() {
      var imageOk = true, instanceOk = true, currState;

      // TODO: Handle 'failed' state of image
      if (!noWait) {
        imageOk = images && _.all(images, function(image) { currState = image.State; return image.State === state; });
      }
      if (!noWaitInstance) {
        instanceOk = instances && isRunning;
      }

      //console.error('Waiting for image; ', currState, isRunning);

      if (!instanceOk || !imageOk) {
        return again(5000);
      }

      return last(null, images);
    });
  }, function(err, images) {
    return callback(err, images);
  });
};

/**
 *  Make the given instance answer for the FQDN.
 *
 *  We find, and then associate the appropriate elastic IP to the instance.
 */
libEc2.assignFqdnToInstance = function(argv, context, callback) {

  var instanceId        = argvExtract(argv, 'instance-id,id');
  var fqdn              = argvExtract(argv, 'fqdn');

  if (!instanceId)    { return callback(sg.toError("Need --instance-id")); }
  if (!fqdn)          { return callback(sg.toError("Need --fqdn")); }

  // Allow caller to tell us multiple accts to search
  var extraAccts        = argvExtract(argv, 'extra-accts,accts')       || []; if (!_.isArray(extraAccts))     { extraAccts    = (''+extraAccts).split(','); }
  var extraRoles        = argvExtract(argv, 'extra-roles,roles')       || []; if (!_.isArray(extraRoles))     { extraRoles    = (''+extraRoles).split(','); }
  var extraSessions     = argvExtract(argv, 'extra-sessions,sessions') || []; if (!_.isArray(extraSessions))  { extraSessions = (''+extraSessions).split(','); }

  // Ensure that we have an equal number of extra accts, roles, sessions
  _.each(extraAccts, function(acct, index) {
    extraRoles[index]     = extraRoles[index]     || extraRoles[0];
    extraSessions[index]  = extraSessions[index]  || extraSessions[0];
  });

  //
  var domainName = [], subDomain;

  var parts       = fqdn.split('.');

  domainName.unshift(parts.pop());
  domainName.unshift(parts.pop());
  domainName = domainName.join('.');

  subDomain  = parts.join('.');
  var addresses, resourceRecordSets = [];

  return sg.__runll([function(next) {
    return raEc2.getAddresses(argv, context, function(err, addresses_) {
      if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.getAddresses'); }
      addresses = addresses_;
      return next();
    });

  }, function(next) {
    // Get rrs from the main account (the one that the change is going to be in)
    var params = _.extend({domain : domainName+'.', zero:true}, argv);
    return raRoute53.listResourceRecordSets(params, context, function(err, recordSets) {
      if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.listResourceRecordSets'); }
      resourceRecordSets = resourceRecordSets.concat(recordSets.ResourceRecordSets);
      return next();
    });

  }, function(next) {
    // Get rrs from the extra accounts
    sg.__eachll(extraAccts, function(acct, nextAcct, index) {
      var params = {
        domain  : domainName+'.',
        zero    : true,
        acct    : acct,
        role    : extraRoles[index],
        session : extraSessions[index]
      };
      params = _.extend(params, argv);

      return raRoute53.listResourceRecordSets(params, context, function(err, recordSets) {
        if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.listResourceRecordSets-extra'); }
        resourceRecordSets = resourceRecordSets.concat(recordSets.ResourceRecordSets);
        return nextAcct();
      });
    }, function() {
      return next();
    });

  }], function() {
    var ip, address;
    _.each(resourceRecordSets, function(recordSet) {
      if (recordSet.Name === fqdn+'.' && recordSet.Type === 'A') {
        if (recordSet.ResourceRecords && recordSet.ResourceRecords.length > 0) {
          ip = recordSet.ResourceRecords[0].Value;
        }
      }
    });

    if (ip) {
      _.each(addresses, function(address_) {
        if (address_.PublicIp === ip) {
          // address is our EIP
          address = address_;
        }
      });

      if (address) {
        var aaParams = _.extend({ AllocationId : address.AllocationId, InstanceId : instanceId}, argv);

        return raEc2.associateAddress(aaParams, context, function(err, result) {
          if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.associateAddress'); }

          return callback(err, result);
        });
      }

      /* otherwise -- found IP, not address */
      console.error("Found IP, not Address: "+ip+" maybe you want to add *****  --session=prod --acct=244406501905 --role=mario-mobilewebprint *****");
      _.each(addresses, function(address) {
        console.error('address:', sg.inspect(address));
      });
      return callback(sg.toError("Found IP, not Address: "+ip+" maybe you want to add *****  --session=prod --acct=244406501905 --role=mario-mobilewebprint *****"));
    }

    /* otherwise -- did not find IP address */
    return callback(sg.toError("Did not find IP"+" maybe you want to add *****  --session=prod --acct=244406501905 --role=mario-mobilewebprint *****"));
  });
};

/**
 *
 */
libEc2.clusterIps = function(argv, context, callback) {
  var result      = {};
  var namespace   = argvExtract(argv, 'namespace,ns')       || 'mario';
  var namespaceEx = argvExtract(argv, 'namespace_ex,ns_ex') || namespace+'3';

  var resultDebug = [];

  var data = {};
  return sg.__runll([function(next) {
    return raVpc.getVpcs(argv, context, function(err, vpcs) {
      if (err) { return die(err, callback, 'libEc2.clusterIps.getVpcs'); }
      data.vpcs = vpcs;
      return next();
    });
  }, function(next) {
    return raEc2.getInstances({}, context, function(err, instances) {
      if (err) { return die(err, callback, 'libEc2.clusterIps.getInstances'); }
      data.instances = instances;
      return next();
    });
  }], function() {

    var ourVpcs = sg.reduce(data.vpcs, {}, function(m, vpc, name) {
      if (sg.startsWith(deref(vpc, 'Tags.aws.cloudformation.stackName'), namespaceEx)) {
        return sg.kv(m, name, vpc);
      }

      return m;
    });

    var ourInstances = {};
    _.each(data.instances, function(instance, instanceId) {
      if (!instance.VpcId) {
        return resultDebug.push({noVpcInstance: instance});
      }

      if (!instance.PrivateIpAddress) {
        return resultDebug.push({noPrivateIp : instance});
      }

      if (deref(instance, 'State.Name') !== "running") {
        return resultDebug.push({notRunning : instance});
      }

      if (deref(instance, 'Tags.participation') === "building") {
        return resultDebug.push({building : instance});
      }

      if (instance.VpcId in ourVpcs) {
        ourInstances[instance.PrivateIpAddress] = instance;
      }
    });
    result.ourInstances = ourInstances;

//    result.debug = resultDebug;
    return callback(null, result);
  });
};

/**
 *
 */
libEc2.current = function(argv, context, callback) {

  var namespace         = argvExtract(argv, 'namespace,ns')         || 'mario';
  var namespaceEx       = argvExtract(argv, 'namespace-ex,ns-ex')   || namespace+'3';
  var domainName        = argvExtract(argv, 'domain-name');
  var trimmed           = argvExtract(argv, 'trimmed');
  var size              = argvExtract(argv, 'size')                 || 9;
  var fullInstances     = argvExtract(argv, 'full-instances')       || false;
  var skipProd          = argvExtract(argv, 'skip-prod')            || false;
  var showAll           = argvExtract(argv, 'show-all,all')         || false;
  var showBlack         = argvExtract(argv, 'show-black,show-k')    || false;
  var showTransparent   = argvExtract(argv, 'show-trans,show-x')    || false;
  var iAmProd;

  var result            = {};
  var g                 = {};
  var problems          = [];
  var resultDebug       = [];

  return fetch(jsaws.envInfo, g, 'envInfo', argv, context, callback, function() {

    iAmProd = (g.envInfo.accountId !== '084075158741');
    domainName = domainName || g.envInfo.accountId === '084075158741' ? 'mobiledevprint.net' : 'mobilewebprint.net';

    return sg.__runll([function(next) {

        var params = { domain_name : /mobile...print[.]net/ };
        return fetch2('listRRSEz', raRoute53.listResourceRecordSetsEz, 'ResourceRecordSets', g, 'recordSets', params, context, callback, function() {

          // Add hq.mobilewebprint.net, it is not in our Route53
          g.recordSets.push({
            Name              : 'hq.mobilewebprint.net.',
            Type              : 'A',
            TTL               : 300,
            ResourceRecords   : [{ 'Value' : '54.83.104.186'}]
          });
          return next();
        });

    }, function(next) {

      //if (iAmProd || skipProd)    { return fetch(raVpc.getVpcs, g, 'vpcs', argv, context, callback, next); }
      //return fetch(raVpc.get2Vpcs, g, 'vpcs', argv, context, callback, next);
      return fetch2('getVpcs', raVpc.getVpcs, null, g, 'vpcs', argv, context, callback, next);

    }, function(next) {

      //if (iAmProd || skipProd)    { return fetch(raEc2.getInstances, g, 'instances', argv, context, callback, next); }
      //return fetch(raEc2.get2Instances, g, 'instances', argv, context, callback, next);
      return fetch2('getInstances', raEc2.getInstances, null, g, 'instances', argv, context, callback, next);

    }, function(next) {
      return next();

      g.prodRecordSets = {ResourceRecordSets : []};
      if (iAmProd)     { return next(); }
      if (skipProd)    { return next(); }

      return fetchFrom('10.10.0.251:21234', '/env/info', g, 'prodEnvInfo', {}, null, context, callback, function(err, data) {
        var prodDomainName = g.prodEnvInfo.accountId === '084075158741' ? 'mobiledevprint.net' : 'mobilewebprint.net';

        return fetchFrom('10.10.0.251:21234', '/route53/listHostedZones', g, 'prodHostedZones', {}, null, context, callback, function(err, zones) {
          var zoneId;

          _.each(zones.HostedZones, function(zone) {
            if (deref(zone, 'Config.PrivateZone') === false) {
              if (deref(zone, 'Name') === prodDomainName+'.') {
                zoneId = deref(zone, 'Id');
              }
            }
          });

          if (!zoneId) { return callback(sg.toError("Cannot determine zoneId")); }

          var params = { HostedZoneId : zoneId };
          return fetchFrom('10.10.0.251:21234', '/route53/listResourceRecordSets', g, 'prodRecordSets', {}, params, context, callback, function(err, data) {
            return next();
          });
        });
      });

    }], function() {

      var m, i;
      var ourVpcs = {};
      var fqdns = {}, ourRoute53Ips = {}, clusterDnsNames = {}, stacks = {};

      var ourInstances = {};

      var instancesBy = {};
      var instancesByPublicIp   = instancesBy.publicIp  = {};
      var instancesByPrivateIp  = instancesBy.privateIp = {};
      var instancesByFqdn       = instancesBy.fqdn      = {};
      var instancesByService    = instancesBy.service   = {};

      instancesBy.color = {};
      instancesBy.stack = {};
      instancesBy.build = {};
      instancesBy.colorStack = {};

      // Find our VPCs
      _.each(g.vpcs, function(vpc, name) {
        if (sg.startsWith(deref(vpc, 'Tags.aws.cloudformation.stackName'), namespaceEx)) {
          ourVpcs[name] = vpc;
        }
      });

      // Process the Route53 record sets
      var ourSubdomains = {};
      _.each(g.recordSets, function(rs) {
        var parts     = rs.Name.replace(/\.+$/, '').split('.');
        var dn        = _.last(parts, 2).join('.');
        var sd        = _.first(parts, parts.length - 2).join('.');
        var fqdn      = [sd, dn].join('.');
        var rsValue   = rs.ResourceRecords[0].Value;

        if (dn.match(/mobile...print.net/i)) {
          if ((m = sd.match(/^(green|blue|teal|yellow|black)-[a-zA-Z0-9]+$/i))) {
            fqdns[fqdn] = rs;
            ourSubdomains[sd] = rs;
            if (rs.Type === 'A')    { ourRoute53Ips[rsValue] = rs.Name.replace(/\.$/g, ''); }

          } else if ((m = sd.match(/((cnb|dev|develop|test|pub|burn)([0-9]*))$/i)) || sd === 'cluster' || sd === 'hq' || sd === 'faceinahole') {
            fqdns[fqdn] = rs;
            ourSubdomains[sd] = rs;
            if (rs.Type === 'A')    { ourRoute53Ips[rsValue] = rs.Name.replace(/\.$/g, ''); }

            clusterDnsNames[sd || m[1]] = fqdn;
          }
        }
      });

      // Determine various things about our instances (ours are in our VPCs)
      var webInstancesWithoutRoute53 = {};
      var ourDnsEntries = sg.reduce(ourRoute53Ips, {}, function(m, v, k) { return sg.kv(m, k, v.replace(/\.+$/, '')); });
      _.each(g.instances, function(instance_, instanceId) {
        var instance = instance_;
        if (trimmed) {
          instance = _.omit(instance_, 'NetworkInterfaces', 'BlockDeviceMappings', 'Placement');
        }

        if (!instance.VpcId) { problems.push({noVpc:instance}); return; }

        // Is this instance in our VPC?
        if (instance.VpcId in ourVpcs) {
          var subdomain;

          // Does the instance have its own namespace, or should we use the passed-in one?
          var instanceNamespace   = deref(instance, 'Tags.namespace');

          var color               = deref(instance, 'Tags.'+(instanceNamespace || namespace)+'.color') || 'nocolor';
          var stack               = deref(instance, 'Tags.'+(instanceNamespace || namespace)+'.stack') || 'nostack';
          var build               = deref(instance, 'Tags.'+(instanceNamespace || namespace)+'.build') || '--';
          var service             = deref(instance, 'Tags.'+(instanceNamespace || namespace)+'.service') || 'noservice';

          // If there is an instance-specific namespace, and bare color,stack,build -- use the bare ones
          if (instanceNamespace) {
            color               = deref(instance, 'Tags.color')   || color;
            stack               = deref(instance, 'Tags.stack')   || stack;
            build               = deref(instance, 'Tags.build')   || build;
            service             = deref(instance, 'Tags.service') || service;
          }

          if (!instance.PrivateIpAddress) { problems.push({noPrivateIp: instance}); }

          if (instance.PrivateIpAddress) {
            instancesByPrivateIp[instance.PrivateIpAddress] = instance;
          }

          if (instance.PublicIpAddress) {
            instancesByPublicIp[instance.PublicIpAddress]   = instance;

            if (instance.PublicIpAddress in ourDnsEntries) {
              instance.route53Name = ourDnsEntries[instance.PublicIpAddress];
              instancesByFqdn[instance.route53Name]           = instance;
              delete ourDnsEntries[instance.PublicIpAddress];
            }
          }

          setOnn(instancesByService, [service, instance.InstanceId], instance);

          setOn(instance, 'Tags.ns.color', color);
          setOn(instance, 'Tags.ns.stack', stack);
          setOn(instance, 'Tags.ns.build', build);
          setOn(instance, 'Tags.ns.service', service);

          if (service === 'web') {
            subdomain = setOnn(instance, 'Tags.ns.subdomain', color+'-'+stack);
            if (!instance.route53Name) {
              setOnn(webInstancesWithoutRoute53, subdomain, instance);
            }
          }

          setOn(instancesBy.color,      [color, instance.InstanceId], instance);
          setOn(instancesBy.stack,      [stack, instance.InstanceId], instance);
          setOn(instancesBy.build,      [build, instance.InstanceId], instance);

          setOn(instancesBy.colorStack, [stack, color, instance.InstanceId], instance);

          ourInstances[instanceId] = instance;
        }
      });

      _.each(webInstancesWithoutRoute53, function(instance, subdomain) {
        var fqdn = subdomain+'.'+domainName;
        if (fqdn in fqdns) {
          instance.unRoute53Name = fqdn;
        }
      });

      stacks.byStack = {};
      _.each(instancesByFqdn, function(instance, fqdn) {
        var parts     = fqdn.replace(/\.+$/, '').split('.');
        var dn        = _.last(parts, 2).join('.');
        var sd        = _.first(parts, parts.length - 2).join('.');

        parts = sd.split('-');
        if (parts.length === 1)   { parts.unshift('nocolor'); }

        var color   = instance.color = parts[0];
        var stack   = instance.stack = parts[1];

        // Index by stack name
        stacks.byStack[stack]         = stacks.byStack[stack] || {};
        stacks.byStack[stack][color]  = instance;
      });

      stacks.byRoute = {};
      _.each(stacks.byStack, function(colorStacks, stackName) {
        var colors = sg.reduce(colorStacks, {}, function(m, v, k) { return sg.kv(m, k, true); });
        stacks.byRoute[stackName] = {};

        // Get the default stack
        if (colorStacks.nocolor) {
          stacks.byRoute[stackName].main = colorStacks.nocolor;
          stacks.byRoute[stackName].determinedMain = colorStacks.nocolor;
          delete colors.nocolor;
        }

        // Loop over the remaining stacks and find the earliest one
        var earliest = Infinity, earliestColor, time;
        _.each(colors, function(value, color) {
          if ((time = new Date(colorStacks[color].LaunchTime).getTime()) < earliest) {
            earliest = time;
            earliestColor = color;
          }
        });

        if (!stacks.byRoute[stackName].determinedMain) {
          stacks.byRoute[stackName].determinedMain = colorStacks[earliestColor];
          delete colors[earliestColor];

        } else if (!stacks.byRoute[stackName].determinedNext) {
          stacks.byRoute[stackName].determinedNext = colorStacks[earliestColor];
          delete colors[earliestColor];
        }

        // One more time -- try and find the next earliest one
        if (!stacks.byRoute[stackName].next) {
          earliest      = Infinity;
          earliestColor = null;
          _.each(colors, function(value, color) {
            if ((time = new Date(colorStacks[color].LaunchTime).getTime()) < earliest) {
              earliest = time;
              earliestColor = color;
            }
          });

          if (earliestColor) {
            stacks.byRoute[stackName].determinedNext = colorStacks[earliestColor];
            delete colors[earliestColor];
          }
        }
      });

      _.each(stacks.byRoute, function(stacks, name) {
        if (stacks.main)    { setOn(stacks.main, 'Tags.ns.route', 'main'); }
        if (stacks.next)    { setOn(stacks.next, 'Tags.ns.route', 'next'); }

        if (stacks.determinedMain)    { setOn(stacks.determinedMain, 'Tags.ns.determinedRoute', 'main'); }
        if (stacks.determinedNext)    { setOn(stacks.determinedNext, 'Tags.ns.determinedRoute', 'next'); }
      });

      var routes = {};
      _.each(stacks.byRoute, function(stacks, name) {
        var route = routes[name] = routes[name] || {};

        if (stacks.main)    { route.main = fullInstances ? stacks.main : _.pick(stacks.main, 'route53Name', 'InstanceId', 'PrivateIpAddress', 'PublicIpAddress', 'Tags', 'LaunchTime'); }
        if (stacks.next)    { route.next = fullInstances ? stacks.next : _.pick(stacks.next, 'route53Name', 'InstanceId', 'PrivateIpAddress', 'PublicIpAddress', 'Tags', 'LaunchTime'); }

        if (!fullInstances) {
          if (stacks.main) {
            setOn(route.main, 'color', deref(route.main, 'Tags.mario.color'));
            setOn(route.main, 'build', deref(route.main, 'Tags.mario.build'));
            delete route.main.Tags;
          }

          if (stacks.next) {
            setOn(route.next, 'color', deref(route.next, 'Tags.mario.color'));
            setOn(route.next, 'build', deref(route.next, 'Tags.mario.build'));
            delete route.next.Tags;
          }
        }
      });

      var fullHumanReport = [], hr = {};
      sg.each(instancesBy.colorStack, function(stackInstances, stack, ibc) {
        var fqdn;

        //
        //  We are now processing the stack 'stack'
        //

        fullHumanReport.push('');
        fullHumanReport.push('== '+stack+' == '+namespace+' ===========================================================================================================================================');
        fullHumanReport.push('');

        // Does this stack have a main and/or a next?
        var hasMain, hasNext;
        _.each(stackInstances, function(colorInstances, color) {
          _.each(colorInstances, function(instance, instanceId) {
            if (instance.Tags.ns.service === 'web') {
              hasMain   = hasMain || (deref(instance, 'Tags.ns.route') === 'main') ? [stack,color].join('.') : null;
              hasNext   = hasNext || (deref(instance, 'Tags.ns.route') === 'next') ? [stack,color].join('.') : null;
            }
          });
        });

        // Loop over the colors of the stack (a 'build' or 'deployment')
        sg.each(stackInstances, function(colorInstances, color, si) {

          if (color === 'transparent' && !showTransparent)      { return; }
          if (color === 'black' && !showBlack)                  { return; }

          fullHumanReport.push('-- '+stack+' -- '+color+' ---------------------------------------------');

          var hasWebTier, buildNum = -1;
          var promoteToMain, promoteToColor, promoteToHq;
          var instanceIds = [];

          // Loop over the instances in the deployment in 2 passes - pass zero for the web-tier, pass one for others
          _.each(_.range(0,2), function(runNum) {
            var group = (runNum === 0) ? 'external' : 'internal';

            // Loop over the instances
            sg.each(colorInstances, function(instance, instanceId, ci/*index, isFirstColorInstance, isLast*/) {

              // BBB: For the report, this is where we are seeing the `instance` to examine or get data
              //if (ibc.first && si.first && runNum === 0 && ci.first) { console.error(sg.inspect(instance)); }

              var service           = deref(instance, 'Tags.ns.service');
              var serviceIndex      = service;
              var runningStateName  = deref(instance, 'State.Name');
              var instanceType      = deref(instance, 'InstanceType');
              var howExpensive      = '';

              if (instanceType.match(/[0-9]xlarge/i)) {
                howExpensive = '++';
              } else if (instanceType.match(/xlarge/i)) {
                howExpensive = '+';
              }

              if (runningStateName !== 'running') {
                howExpensive = '';
              }

              if (instance.route53Name) {
                fqdn = instance.route53Name;
              }

              // Do we already have one of these services?
              if (deref(hr, [stack,color,group, serviceIndex])) {
                for (i = 2; i < 99; i++) {
                  serviceIndex = service+sg.pad(i,2);
                  if (!deref(hr, [stack,color,group, serviceIndex])) {
                    break;
                  }
                }
              }

              setOnn(hr, [stack,color,group, serviceIndex, 'service'],     service);
              setOnn(hr, [stack,color,group, serviceIndex, 'instanceId'],  instanceId);

              var subdomain        = setOnn(hr, [stack,color,group, serviceIndex, 'subdomain'],       deref(instance, 'Tags.ns.subdomain'));
              var route            = setOnn(hr, [stack,color,group, serviceIndex, 'route'],           deref(instance, 'Tags.ns.route'));
              var determinedRoute  = setOnn(hr, [stack,color,group, serviceIndex, 'd_route'],         deref(instance, 'Tags.ns.determinedRoute'));
              var ip               = setOnn(hr, [stack,color,group, serviceIndex, 'ip'],              instance.PrivateIpAddress);
              var publicIp         = setOnn(hr, [stack,color,group, serviceIndex, 'publicIp'],        instance.PublicIpAddress);
              var build            = setOnn(hr, [stack,color,group, serviceIndex, 'build'],           deref(instance, 'Tags.ns.build'));

              var participation    = deref(instance, 'Tags.participation') || (runningStateName !== 'running' ? runningStateName : null);

              setOnn(hr, [stack,color,group, serviceIndex, 'participation'], participation);
              setOnna(hr, [stack,color,group,serviceIndex, 'name'], ourRoute53Ips[publicIp]);
              setOnna(hr, [stack,color,group,serviceIndex, 'unName'], instance.unRoute53Name);

              if (build > buildNum) {
                buildNum = build;
              }

              //console.error(runNum, group, color, stack, serviceIndex, '---');
              var msg              = '';
              msg                 += '  '+ sg.pad(route || participation || '',                      10);
              msg                 += '  '+ sg.pad(subdomain || '',                                   18);
              msg                 += '  '+sg.lpad(ip,                                                17);
              msg                 += '  '+sg.lpad(instanceType,                                      10);
              msg                 += '  '+sg.lpad(howExpensive,                                       2);
              msg                 += '  '+ sg.pad(instanceId,                                        16);
              msg                 += '  '+sg.lpad(build,                                              4);
              msg                 += '  '+sg.lpad(service,                                           10);
              msg                 += '  '+sg.lpad(publicIp || '',                                    17);
              //msg                 += '  '+sg.pad((determinedRoute?'('+determinedRoute+')':''),        8);
              msg                 += '  '+(instance.route53Name || '');

              if (runNum === 0 && instance.Tags.ns.service === 'web') {

                // We are processing the web-tier instances
                hasWebTier = true;
                instanceIds.push(instanceId);

                promoteToMain  = mkPromoteCmd(stack, domainName, instance.InstanceId);
                promoteToColor = mkPromoteCmd(subdomain, domainName, instance.InstanceId);

                // Special to promote to HQ server
                if (stack === 'cluster') {
                  promoteToHq  = mkPromoteCmd('hq', domainName, instance.InstanceId);
                }

              } else if (runNum === 1 && instance.Tags.ns.service !== 'web') {

                if (showAll || (instance.Tags.ns.service !== 'db' && instance.Tags.ns.service !== 'util')) {
                  // We are processing the non-web-tier instances
                  instanceIds.push(instanceId);
                }

              } else {

                // Because we run twice, we need this else clause to handle when we have an
                // instance that is in the other group.

                //console.error(runNum, group, color, stack, instance.Tags.ns.service);
                delete hr[stack][color][group][serviceIndex];
                msg = null;
              }
              //console.error(sg.inspect(hr));

              if (msg) {
                fullHumanReport.push(msg);
                //console.error(msg);
              }
            });

            // We have completed one group

          });

          setOnn(hr, [stack,color, 'build'], buildNum);

          // We have completed both passes -- do commands
          if (hasWebTier) {
            if (promoteToMain)    { setOnn(hr, [stack,color, 'commands', 'promoteToMain'],  promoteToMain); }
            if (promoteToHq)      { setOnn(hr, [stack,color, 'commands', 'promoteToHq'],    promoteToHq); }
            if (promoteToColor)   { setOnn(hr, [stack,color, 'commands', 'promoteToColor'], promoteToColor); }

          }
          setOnn(hr, [stack,color, 'commands', 'terminateAll'], 'aws ec2 terminate-instances --instance-ids '+instanceIds.join(' '));
          setOnn(hr, [stack,color, 'commands', 'stopAll'], 'aws ec2 stop-instances --instance-ids '+instanceIds.join(' '));

          if (hasWebTier) {
            fullHumanReport.push('');

            if (!hasMain) {
//              fullHumanReport.push('  To promote to main:');
//              fullHumanReport.push('    '+promoteToMain);

              if (promoteToHq) {
                fullHumanReport.push('  To promote to main:');
                fullHumanReport.push('    '+promoteToHq);
              }
            }

//            if (!hasNext) {
//              fullHumanReport.push('  To promote to next:');
//              fullHumanReport.push('    '+promoteToColor);
//            }

            if ((promoteToColor.indexOf(fqdn) === -1) || (promoteToHq && (promoteToHq.indexOf(fqdn) === -1))) {
              fullHumanReport.push('');
              fullHumanReport.push('  Promotions:');
            }

            //if ((promoteToMain.indexOf(fqdn) === -1))   { fullHumanReport.push('    '+promoteToMain); }
            if ((promoteToColor.indexOf(fqdn) === -1))  { fullHumanReport.push('    '+promoteToColor); }

            if (promoteToHq) {
              if ((promoteToHq.indexOf(fqdn) === -1))  {
                fullHumanReport.push('    '+promoteToHq);
                fullHumanReport.push('  ');

                fullHumanReport.push("    sshx scotty@"+fqdn+" 'rm -f ~/tmp/nginx/certs/hq.mobilewebprint.net*' &&");
                fullHumanReport.push("    scpx ~/.ssh/keys/chained/hq.mobilewebprint.net/* scotty@"+fqdn+":~/tmp/nginx/certs/ &&");
                fullHumanReport.push("    sshx scotty@"+fqdn+" 'sudo nginx -t && sudo nginx -s reload || sudo nginx'");
              }
            }
          }

          fullHumanReport.push('');
          fullHumanReport.push('  To terminate group:');
          fullHumanReport.push('    aws ec2 terminate-instances --instance-ids '+instanceIds.join(' '));

          fullHumanReport.push('');
          //fullHumanReport.push('------------------------------------------------------------');

        });

        // We have just finished a stack
        setOnn(hr, [stack, 'main'], hasMain);
        setOnn(hr, [stack, 'next'], hasNext);

      });
      fullHumanReport.push('');

      if (size >= 5) { result.ourInstances     = ourInstances; }
      if (size >= 4) { result.instancesByFqdn  = instancesByFqdn; }
      if (size >= 3) { result.stacks           = stacks; }

      result.ourVpcs          = ourVpcs;
      result.fqdns            = fqdns;
      result.ourRoute53Ips    = ourRoute53Ips;
      result.ourDnsEntries    = ourDnsEntries;
      result.clusterDnsNames  = clusterDnsNames;
      result.routes           = routes;

      //result.instancesByColor = instancesBy.color;
      //result.instancesByStack = instancesBy.stack;
      result.instancesByColorStack = instancesBy.colorStack;
      result.hr               = hr;
      result.report           = fullHumanReport.join('\n');
      result.debug            = resultDebug;
      callback(null, result);
    });
  });
};

/**
 *  Evaluate the stack situation.
 */
libEc2.evaluate = function(argv, context, callback) {

  var namespace     = argvExtract(argv, 'namespace,ns')         || 'mario';
  var namespaceEx   = argvExtract(argv, 'namespace-ex,ns-ex')   || namespace+'3';
  var domainName    = argvExtract(argv, 'domain-name');
  var currArgv      = _.extend({size:9, fullInstances:true}, argv);

  if (!namespaceEx)   { return die(sg.toError('Must provide --namespace-ex'), callback); }

  var problems  = [];
  var advice    = [];

  var g = {};
  return fetch(jsaws.envInfo, g, 'envInfo', argv, context, callback, function() {
    domainName = domainName || g.envInfo.accountId === '084075158741' ? 'mobiledevprint.net' : 'mobilewebprint.net';

    return raEc2.current(currArgv, context, function(err, current) {
      var promotions = {};

      var stacks = {};
      _.each(current.ourInstances, function(instance, instanceId) {
        setOn(stacks, deref(instance, ['Tags', namespace, 'stack']), true);
      });
      if (stacks.cluster) {
        stacks.pub = stacks.test = stacks.develop = stacks.burn = stacks.burn2 = true;
      }

      _.each(current.routes, function(routes, stackName) {
        // You need a main route
        if (!routes.main)   { problems.push({noMain: stackName}); }

        // The main route should be non-colored
        if (routes.main) {
          if (routes.main.color !== 'nocolor')  { problems.push({coloredMain: routes.main.route53Name}); }
        }

        // To promote next to main:
        if (routes.next) {
          promotions[stackName] = './assignFqdnToInstance --fqdn='+stackName+'.'+domainName+' --instance-id='+routes.next.InstanceId;
        } else if (routes.main && routes.main.color !== 'nocolor') {
          promotions[stackName] = './assignFqdnToInstance --fqdn='+stackName+'.'+domainName+' --instance-id='+routes.main.InstanceId;
        }
      });
      advice.push({toPromote: promotions});

      // Advise a buildout
      var buildColor = sg.reduce('green,blue,teal,yellow'.split(','), null, function(m, color) {
        if (m) { return m; }

        var instanceId;
        for (instanceId in _.keys(current.ourInstances)) {
          instanceId = _.keys(current.ourInstances)[instanceId];

          if (deref(current.ourInstances, [instanceId, 'Tags', namespace, 'stack']) === 'develop') { continue; }
//          if (current.ourInstances[instanceId].Tags[namespace].stack !== 'develop') { continue; }

          if (deref(current.ourInstances, [instanceId, 'Tags', namespace, 'color']) === color) {
//          if (current.ourInstances[instanceId].Tags[namespace].color === color) {
            // If we already have one from this color, bail
            return m;
          }
        }

        return color;
      });
      //advice.push({buildColor: buildColor});
      advice.push({build: 'time ./build-servers --my-env=development --db='+dbIp('develop',220)+' --util='+utilIp('develop',4)+' --'+buildColor+' --services=cont,web,netapp --skip-relaunch --from-base'});
      advice.push({build: 'time ./build-servers --my-env=development --db='+dbIp('develop',220)+' --util='+utilIp('develop',4)+' --'+buildColor+' --services=cont,web,netapp,rip --skip-relaunch'});
      advice.push({build: 'time ./build-servers --my-env=development --db='+dbIp('develop',220)+' --util='+utilIp('develop',4)+' --'+buildColor+' --services=cont,web,netapp,rip,util,db  --quick-rip  --skip-ami  --full-rip2'});
      advice.push({build: 'time ./build-servers --my-env=development --db='+dbIp('develop',220)+' --util='+utilIp('develop',4)+' --'+buildColor+' --services=web --skip-ami'});

      // Advise deploy
      _.each(_.keys(stacks), function(stackName) {
        var deployColor = sg.reduce('green,blue,teal,yellow'.split(','), null, function(m, color) {
          if (m) { return m; }

          var instanceId;
          for (instanceId in _.keys(current.ourInstances)) {
            instanceId = _.keys(current.ourInstances)[instanceId];

            if (current.ourInstances[instanceId].Tags[namespace].stack !== stackName) { continue; }

            if (current.ourInstances[instanceId].Tags[namespace].color === color) {
              // If we already have one from this color, bail
              return m;
            }
          }

          return color;
        });
        //advice.push({deployColor: deployColor});
        advice.push({deploy: 'time ./run-instances-from-amis --build-number=9899 --db='+dbIp(stackName,220)+' --util='+utilIp(stackName,4)+' --stack='+stackName+' --my-env='+size(stackName)+' --'+deployColor+' --services=cont,netapp,web,rip,util,db'});
//        advice.push({build: './build-servers --my-env=small --db='+dbIp(stackName,220)+' --util='+utilIp(stackName,4)+' --'+deployColor+' --services=cont,web,netapp --skip-ami --stack='+stackName});
      });

      return callback(null, {problems:problems, advice:advice});

      function dbIp(stack, octet4_) {
        var result;
        var namespace = process.env.NAMESPACE;
        if (namespace) {
          result = process.env[namespace.toUpperCase()+'_DB_HOSTNAME'] || process.env[namespace.toUpperCase()+'_DB_IP'];
          if (result) {
            return result;
          }
        }
        if (result = process.env.MARIO_DB_HOSTNAME || process.env.MARIO_DB_IP) {
          return result;
        }
        return process.env.SERVERASSIST_DB_HOSTNAME || process.env.SERVERASSIST_DB_IP;
      }

      function utilIp(stack, octet4_) {
        var result;
        var namespace = process.env.NAMESPACE;
        if (namespace) {
          result = process.env[namespace.toUpperCase()+'_UTIL_HOSTNAME'] || process.env[namespace.toUpperCase()+'_UTIL_IP'];
          if (result) {
            return result;
          }
        }
        if (result = process.env.MARIO_UTIL_HOSTNAME || process.env.MARIO_UTIL_IP) {
          return result;
        }
        return process.env.SERVERASSIST_UTIL_HOSTNAME || process.env.SERVERASSIST_UTIL_IP;
      }

      function size(stack) {
        if (sg.startsWith(stack, 'pub'))    { return 'prod'; }
        if (sg.startsWith(stack, 'dev'))    { return 'small'; }
        if (sg.startsWith(stack, 'test'))   { return 'development2'; }
        if (sg.startsWith(stack, 'burn'))   { return 'debug'; }

        if (stack === 'cluster')            { return 'c4xlarge'; }

        return 'small';
      }
    });
  });
};

/**
 *  fetch, using creds, not contacting server in the other acct
 */
var fetch2 = function(dbg, raFn, subName, g, name, argv_, context, outerCallback, callback) {

  var argv = _.extend({}, argv_);

  g[name] = {};

  return raFn(argv, context, function(err, result_) {
    if (err) { return sg.die(err, outerCallback, 'fetching '+name); }

    var result = subName ? result_[subName] : result_;
    if (_.isArray(result)) {
      g[name] = [];
      _.each(result, function(value) {
        g[name].push(value);
      });
    } else {
      _.each(result, function(value, key) {
        g[name][key] = value;
      });
    }

    // Get from prod
    var argv2 = _.extend({}, argv_, {
      session:  'prod',
      account:  '244406501905',
      role:     'mario-mobilewebprint'
    });

    return raFn(argv2, context, function(err, result_) {
      if (err) { return sg.die(err, outerCallback, 'fetching '+name); }

      var result = subName ? result_[subName] : result_;
      if (_.isArray(result)) {
        _.each(result, function(value) {
          g[name].push(value);
        });
      } else {
        _.each(result, function(value, key) {
          g[name][key] = value;
        });
      }

      return callback.apply(this, arguments);
    });
  });
};

var fetch = function(raFn, g, name, argv, context, outerCallback, callback) {
  return raFn(argv, context, function(err, result) {
    if (err) { return sg.die(err, outerCallback, 'fetching '+name); }

    g[name] = result;
    return callback.apply(this, arguments);
  });
};

var fetchFrom = function(ip, path, g, name, query, argv, context, outerCallback, callback) {
  var sa = superagent.post('http://'+ip+path);
  if (argv && sg.numKeys(argv) > 0) {
    sa.send({args: [argv]});
  }

  return sa.end(function(err, res) {
    if (err) { return sg.die(err, outerCallback, 'fetching '+path); }

    g[name] = res.body;
    return callback(err, res.body);
  });
};

/**
 *
 */
libEc2.bigReport = function(argv, context, callback) {
  var domainName  = argvExtract(argv, 'domain-name,domain');
  var namespace   = argvExtract(argv, 'namespace,ns')       || 'mario';
  var namespaceEx = argvExtract(argv, 'namespace_ex,ns_ex') || namespace+'3';
  var result      = {};
  var resultDebug = [];

  var report      = result.report = {};

  if (!domainName)          { return callback(sg.toError("Need --domain-name=")); }

  var zones, addresses, instances, vpcs, subnets, recordSets, interfaces;
  return sg.__runll([function(next) {
    return raVpc.getVpcs(argv, context, function(err, vpcs_) {
      if (err) { return die(err, callback, 'libEc2.current.getVpcs'); }
      vpcs = vpcs_;
      return next();
    });
  }, function(next) {
    return raVpc.getSubnets(argv, context, function(err, subnets_) {
      if (err) { return die(err, callback, 'libEc2.current.getSubnets'); }
      subnets = subnets_;
      return next();
    });
  }, function(next) {
    return raRoute53.listHostedZones(argv, context, function(err, zones_) {
      if (err) { return die(err, callback, 'libEc2.current.listHostedZones'); }
      zones = zones_;
      return next();
    });
  }, function(next) {
    return raEc2.getAddresses(argv, context, function(err, addresses_) {
      if (err) { return die(err, callback, 'libEc2.current.getAddresses'); }
      addresses = addresses_;
      return next();
    });
  }, function(next) {
    return raEc2.getInstances({}, context, function(err, instances_) {
      if (err) { return die(err, callback, 'libEc2.current.getInstances'); }
      instances = instances_;
      return next();
    });
  }, function(next) {
    return raEc2.getNetworkInterfaces({}, context, function(err, interfaces_) {
      if (err) { return die(err, callback, 'libEc2.current.getNetworkInterfaces'); }
      interfaces = interfaces_;
      return next();
    });
  }, function(next) {
    var params = { domain : domainName+'.' };

    return raRoute53.listResourceRecordSets(params, context, function(err, recs) {
      if (err) { return die(err, callback, 'libEc2.current.listResourceRecordSets'); }
      recordSets = recs.ResourceRecordSets;
      return next();
    });
  }], function() {

    var m;

    report.full  = {};
    report.short = {};

    report.full.ipInstances = {};
    var problems = report.full.problems = [];

    // The short report is the one that will get looked at
    report.short.ipInstances = {};

    var mainDns = {};
    var fqdns = {}, ourIpsInRoute53 = {}, otherIpsInRoute53 = {};
    _.each(recordSets, function(rs) {
      var parts = rs.Name.split('.');
      var dn    = _.last(parts, 3).join('.').replace(/\.$/g, '');
      var sd    = _.first(parts, parts.length - 3).join('.');
      var fqdn  = [sd, dn].join('.');

      if (dn.match(/mobile...print.net/)) {
        if (sd.match(/^(green|blue|teal|yellow|black)-[a-zA-Z0-9]+$/)) {
          fqdns[fqdn] = rs;
          if (rs.Type === 'A') { ourIpsInRoute53[rs.ResourceRecords[0].Value] = rs.Name; }
        } else if ((m = sd.match(/((cnb|dev|test|pub)[3-9])$/)) || sd === 'cluster') {
          fqdns[fqdn] = rs;
          if (rs.Type === 'A')      { ourIpsInRoute53[rs.ResourceRecords[0].Value] = rs.Name; }

          mainDns[sd || m[1]] = fqdn;
        } else {
          if (rs.Type === 'A') { otherIpsInRoute53[rs.ResourceRecords[0].Value] = rs.Name; }
          //resultDebug.push({fqdn:fqdn});
        }
      } else {
        //resultDebug.push({fqdn:fqdn});
      }
    });

    var ourVpcs = sg.reduce(vpcs, {}, function(m, vpc, name) {
      if (sg.startsWith(deref(vpc, 'Tags.aws.cloudformation.stackName'), namespaceEx)) {
        return sg.kv(m, name, vpc);
      }

      return m;
    });

    var ipInstances    = {};
    var ourInstances   = sg.reduce(instances, {}, function(m, instance, name) {
      var ip;
      //resultDebug.push({instance:instance});

      if ((ip = deref(instance, 'PublicIpAddress'))) {
        if (ip in ourIpsInRoute53) {
          var fqdn = ourIpsInRoute53[ip].replace(/\.+$/, '');
          var fullInstance  = report.full.ipInstances[fqdn] = ipInstances[fqdn] = {
            name        : fqdn,
            publicIp    : ip,
            privateIp   : instance.PrivateIpAddress,
            instance    : instance,
            instanceId  : instance.InstanceId,
            launchTime  : instance.LaunchTime,
            state       : instance.State.Name,
            subnetCidr  : subnets[instance.SubnetId].CidrBlock
          };

          var shortInstance = report.short.ipInstances[fqdn]  = _.omit(ipInstances[fqdn], 'instance');
        }
      }

      if (instance.VpcId) {
        if (instance.VpcId in ourVpcs) {
          //resultDebug.push({ip: instance.PrivateIpAddress});
          return sg.kv(m, name, instance);
        }
      } else {
        resultDebug.push({noVpc: instance.InstanceId});
      }
      return m;
    });

    // The main dns for a stack
    var stackReport = report.short.stacks = {};
    _.each(report.short.ipInstances, function(instance, fqdn) {
      var parts = fqdn.split('.');
      var dn    = _.last(parts, 2).join('.');
      var sd    = _.first(parts, parts.length - 2).join('.');

      parts = sd.split('-');
      if (parts.length === 1) { parts.unshift('none'); }

      var color = instance.color = parts[0];
      var stack = instance.stack =  parts[1];

      stackReport[stack] = stackReport[stack] || {byColor:{}};
      stackReport[stack].byColor = sg.kv(stackReport[stack].byColor, color, instance);
    });

    _.each(stackReport, function(stack, stackName) {
      if (!(stack.current = stack.byColor.none)) {
        stack.current =  stack.byColor[sg.firstKey(stack.byColor)];

        _.each(stack.byColor, function(colorStack, color) {
          if ((new Date(stack.current.launchTime).getTime()) > (new Date(colorStack.launchTime).getTime())) {
            stack.current = colorStack;
          }
        });
      }

      var s = _.filter(stack.byColor, function(colorStack, color) {
        return colorStack.instanceId !== stack.current.instanceId;
      });

      if (s.length > 0) {
        stack.next = s[0];
      }
    });

    result.ourInstances = ourInstances;

    var ourAssgnAdds_AssocIds = {};
    var ourUnassignedAddresses = {};
    var ourAssignedAddresses = sg.reduce(addresses, {}, function(m, address) {
      //if (!address.AllocationId) { resultDebug.push({noallocationid: address}); }

      if (address.InstanceId in ourInstances) {
        ourAssgnAdds_AssocIds[address.AssociationId] = address;
        return sg.kv(m, address.AllocationId, address);
      } else if (address.PublicIp in ourIpsInRoute53) {
        ourUnassignedAddresses[address.AllocationId] = address;
        //return sg.kv(m, address.AllocationId, address);
      }

      return m;
    });

    var ourInterfaces = sg.reduce(interfaces, {}, function(m, interface, name) {
      if (interface.VpcId in ourVpcs) {
        if (deref(interface, "Association.AssociationId") in ourAssgnAdds_AssocIds) {
          //resultDebug.push(_.extend({EIP: {ip: interface.PrivateIpAddress, nic:interface}}, {Address: ourAssgnAdds_AssocIds[deref(interface, "Association.AssociationId")]}));
          return m;
        } else if (deref(interface, 'Attachment.InstanceId')) {
          if (deref(interface, 'Association.PublicIp')) {
            //resultDebug.push({publicInstance:{ip: deref(interface, 'Association.PublicIp'), nic:interface}});
          } else {
            //resultDebug.push({instance:{ip: interface.PrivateIpAddress, nic:interface}});
          }
          return m;
        }

        return sg.kv(m, name, interface);
      }
      return m;
    });

    var unAnsweredMainDns = sg.deepCopy(mainDns);
    unAnsweredMainDns = _.filter(unAnsweredMainDns, function(dns) {
      return !(sg.startsWith(dns, 'cnb') || sg.startsWith(dns, 'dev'));
    });

    var dnsReport = report.short.dns = {dangling:{}, live:{}};
    _.each(ourIpsInRoute53, function(name, publicIp) {
      var fqdn = name.replace(/\.+$/, '');
      if (fqdn in ipInstances) {
        // these are the fqdns for which we have servers answering
        dnsReport.live[fqdn] = {publicIp : publicIp, instanceId: ipInstances[fqdn].instance.InstanceId};
        unAnsweredMainDns = _.filter(unAnsweredMainDns, function(unAnsweredFqdn, stackName) { return unAnsweredFqdn !== fqdn; });
      } else {
        dnsReport.dangling[fqdn] = {publicIp : publicIp};
      }
    });

    var liveDnsNames = _.keys(dnsReport.live).sort(function(a, b) {
      return nameScore(a) - nameScore(b);
    });

    dnsReport.live = sg.reduce(liveDnsNames, {}, function(m, name) {
      return sg.kv(m, name, dnsReport.live[name]);
    });

    if (sg.numKeys(unAnsweredMainDns) > 0) {
      problems.push({unAnsweredDns: unAnsweredMainDns});
    }

//    result.zones                  = zones;
//    result.ourVpcs                = ourVpcs;
//    result.fqdns                  = fqdns;
//    result.ourUnassignedAddresses = ourUnassignedAddresses;
//    result.ourInterfaces          = ourInterfaces;
//    result.ourAssignedAddresses   = ourAssignedAddresses;
    result.ourIpsInRoute53        = ourIpsInRoute53;
    result.otherIpsInRoute53      = otherIpsInRoute53;
//    result.ipInstances            = ipInstances;
    result.debug                  = resultDebug;

    report.short.problems = report.full.problems;
    return callback(null, result);
  });
};

/**
 *  Peer a VPC in another account.
 */
libEc2.peerVpcs = function(argv, context, callback) {
  argv                = jsaws.prep(argv);
  var awsEc2          = jsaws.getEc2(argv);

  var from            = argvGet(argv, 'from');
  var toVpcId         = argvGet(argv, 'to-vpc-id,to-vpc');
  var toAcct          = ''+argvGet(argv, 'to-acct-id,to-acct,acct');

  if (!toVpcId || !toAcct || !from) {
    return die("Need ARGV.to-vpc-id,to-acct-id,from", callback, 'libEc2.peerVpcs');
  }

  var fromVpc;
  return raVpc.eachVpc2(function(vpc) {

    if (getClassB(vpc.CidrBlock) === from) { fromVpc = vpc; }

  }, function() {

    if (!fromVpc) {
      return die("Need fromVpc", callback, 'libEc2.peerVpcs');
    }

    var params          = {};
    params.PeerOwnerId  = toAcct;
    params.PeerVpcId    = toVpcId;
    params.VpcId        = fromVpc.VpcId;

    return awsEc2.createVpcPeeringConnection(params, function(err, data) {
      if (err) { return die(err, callback, 'libEc2.peerVpcs'); }

      return callback(null, data);
    });
  });
};

/**
 *  Directly calls AWS createImage API, and does not do any favors
 *  for you. This function is just a run-anywhere-ification of the
 *  AWS createImage API.
 *
 *  The createAmi function has hueristics, assuming you are really
 *  interested in knowing when the creation is completed.
 *
 */
libEc2.createImage = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);

  var ciParams = _.pick(argv, 'NoReboot', 'InstanceId', 'Name', 'Description');
  return awsEc2.createImage(ciParams, function(err, result) {
    if (err) { return die(err, callback, 'createImage.createImage'); }

    return callback(null, result);
  });
};

/**
 *  Terminate instance(s).
 *
 *  TODO: Add the ability to wait.
 */
libEc2.terminateInstance = libEc2.terminateInstances = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);

  var tiParams = {
    InstanceIds : sg.toArray(argvGet(argv, 'instance-ids,instance-id,ids,id')),
    DryRun      : argvGet(argv, 'dry-run,dryrun')
  };

  return awsEc2.terminateInstances(tiParams, function(err, result) {
    return callback.apply(this, arguments);
  });
};

/**
 *  Call AWSs associateAddress, but JS-ify it.
 */
libEc2.associateAddress = function(argv, context, callback) {
  var awsEc2        = awsService('EC2', argv);

  var allocationId  = argvGet(argv, 'allocation-id,allocation');
  var instanceId    = argvGet(argv, 'instance-id,id');

  if (!allocationId)  { return die(sg.toError('Need --allocation-id'), callback, 'associateAddress'); }
  if (!instanceId)    { return die(sg.toError('Need --instance-id'), callback, 'associateAddress'); }

  var params = {
    AllocationId  : allocationId,
    InstanceId    : instanceId
  };

  return awsEc2.associateAddress(params, function(err, result) {
    return callback(err, result);
  });
};

/**
 *  Look at the AMIs, and determine the build number for this namespace
 */
libEc2.getNextBuildNumber = function(argv_, context, callback) {
  var argv      = sg.deepCopy(argv_);
  var namespace = argvExtract(argv, 'namespace,ns');

  if (!namespace) { return callback(sg.toError('Must provide namespace')); }

  return raEc2.getImages(argv, context, function(err, images) {
    var buildNumber = -1, build;
    _.each(images, function(image) {
      if (image.Tags[namespace] && ('build' in image.Tags[namespace])) {
        build = image.Tags[namespace].build;
        if (build.match(/^9999/)) { return; }

        build = +build;
        if (build > buildNumber) {
          buildNumber = build;
        }
      }
    });

    buildNumber = Math.max(buildNumber, 0);
    return callback(null, {build: buildNumber + 1});
  });
};

/**
 *  Get the 'best' AMI for the requirements.
 *
 *    ra invoke lib/ec2/ec2.js getAmiIdsForBuild --namespace=ns3 --stack=develop --build-number=13
 */
libEc2.getAmiIdsForBuild = function(argv_, context, callback) {
  var argv          = sg.deepCopy(argv_);
  var namespace     = argvExtract(argv, 'namespace,ns');
  var stack         = argvExtract(argv, 'stack');
  var buildNumber   = +(argvExtract(argv, 'build-number,build-num,build') || '989999');

  if (!namespace) { return callback(sg.toError('Must provide namespace')); }

  if (stack)      { stack = stack.replace(/[0-9]+/, ''); }

  var maxBuildNumber= -1;
  return raEc2.getImages(argv, context, function(err, images) {

    var results = {}, build, service, readyFor, ready;
    _.each(images, function(image) {
      if (image.ImageId && image.Tags[namespace] && ('build' in image.Tags[namespace]) && ('service' in image.Tags[namespace])) {
        service   = image.Tags[namespace].service;
        readyFor  = image.Tags[namespace].readyFor;
        build     = image.Tags[namespace].build;
        if (build.match(/^9999/)) { return; }

        build     = +build;
        if (build > buildNumber)   { return; }

        results[service]  = results[service] || {};
        if (('build' in results[service])) {
          if (results[service].build > build)         { return; }
        }

        // If we know the stack, check the 'readyFor' attribute
        ready = true;
        if (stack && (stack === 'pub' || stack === 'test' || stack === 'ext')) {
          ready = readyFor && sg.inList(readyFor, stack, ',');
        }

        if (!ready)       { return; }

        results[service].build    = build;
        results[service].imageId  = image.ImageId;

        if (build > maxBuildNumber) {
          maxBuildNumber = build;
        }
      }
    });

    results.buildNumber = maxBuildNumber;
    return callback(null, results);
  });
};

/**
 *  Invoke one of the describe-X functions.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} callback    - Run-anywhere style callback.
 *  @param {string} awsName       - The name of the thing to be described, like "Instances".
 *  @param {string} [awsFnName]   - Sometimes, you cannot just paste "describe"+awsName to get the right function.
 */
var getX2 = function(argv_, context, callback, awsName, awsFnName_) {
  var argv            = sg.deepCopy(argv_);
  var awsFnName       = awsFnName_ || 'describe'+awsName;

  // The AWS EC2 service
  var awsEc2          = awsService('EC2', extractServiceArgs(argv));

  var result;
  return sg.until(function(again, last) {
    return awsEc2[awsFnName](argv || {}, function(err, x) {
      if (err) {
        if (err.code === 'RequestLimitExceeded')    { return again(250); }

        /* otherwise */
        return die(err, callback, 'ec2.getX2.awsEc2.'+awsFnName);
      }

      result = awsJsonLib.awsToJsObject(x);
      result = result[awsName] || result;

      return last();
    });
  }, function(err) {
    return callback(err, result);
  });
};

// ===================================================================================================
//    EC2 describe* APIs (but we use 'get' style)
// ===================================================================================================

//libEc2.getVolumes = function(argv, context, callback) {
//  return getAll(argv, context, callback, 'Volumes');
//};

libEc2.getImages = function(argv_, context, callback) {
  var argv = _.extend({Owners:['self']}, argv_ || {});
  return getX2(argv, context, callback, 'Images');
};

libEc2.getInstances = function(argv, context, callback) {
  return getX2(argv, context, function(err, reservations) {
    if (err) { return callback(err); }

    var result = {};
    sg.eachFrom(reservations.Reservations, "Instances", function(instance, instanceId) {
      result[instanceId] = instance;
    });

    return callback(null, result);
  }, 'Instances');
};

libEc2.getAddresses = function(argv, context, callback) {
  return getX2(argv, context, callback, 'Addresses');
};

libEc2.getNetworkInterfaces = function(argv, context, callback) {
  return getX2(argv, context, callback, 'NetworkInterfaces');
};

// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
//    BEGIN -- the old, complex way to get info from 2 or 3 accounts.
// ---------------------------------------------------------------------------------------------------------------------------------------

// ===================================================================================================

//libEc2.get2Volumes = function(argv, context, callback) {
//  return getAll(argv, context, callback, 'Volumes');
//};

libEc2.get2Images = function(argv_, context, callback) {
  var argv = _.extend({Owners:['self']}, argv_ || {});
  return get2X2(argv, context, callback, 'Images');
};

libEc2.get2Instances = function(argv, context, callback) {
  return get2X2_2(argv, context, function(err, the2) {
    if (err) { return callback(err); }

    var result = {};
    sg.eachFrom(the2.x.Reservations, "Instances", function(instance, instanceId) {
      result[instanceId] = instance;
    });

    sg.eachFrom(the2.foreignX.Reservations, "Instances", function(instance, instanceId) {
      result[instanceId] = instance;
    });

    return callback(null, result);
  }, 'Instances');
};

libEc2.get2Addresses = function(argv, context, callback) {
  return get2X2(argv, context, callback, 'Addresses');
};

//libEc2.get2NetworkInterfaces = function(argv, context, callback) {
//  return get2X2(argv, context, callback, 'NetworkInterfaces');
//};

// ===================================================================================================
//    Raw EC2 describe* APIs
// ===================================================================================================

libEc2.ec2Describe = function(argv, context, callback) {
  var funcname      = argvExtract(argv, 'funcname,name');
  var funcargs      = argvExtract(argv, 'args')             || [{}];

  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);

  if (!awsEc2[funcname]) { return callback(sg.toError('No such function')); }

  funcargs.push(function(err, data) {
    return callback(err, awsJsonLib.awsToJsObject(data));
  });

  return awsEc2[funcname].apply(awsEc2, funcargs);
};

// ---------------------------------------------------------------------------------------------------------------------------------------
//    END -- the old, complex way to get info from 2 or 3 accounts.
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------------------------------

// From: https://cloud-images.ubuntu.com/locator/ec2/
// hvm:ebs-ssd updated 2016-10-26
var amis = {

  // N.Virginia -- Search with 'us-east hvm ebs-ssd amd64 lts'
  us_east_1: {
    precise : 'ami-4b8bd85c',
    trusty  : 'ami-c8580bdf',
    xenial  : 'ami-40d28157'
  },

  // Tokyo -- Search with 'ap-northeast-1 hvm ebs-ssd amd64 lts'
  ap_northeast_1: {
    precise : 'ami-199e3878',
    trusty  : 'ami-c88325a9',
    xenial  : 'ami-0567c164'
  }
};

// Our Trusties, based on the above
amis.us_east_1.trusty2  = 'ami-5a6ef94c';   // A custom made ami to speed up the buildout process   23
amis.us_east_1.trusty2  = 'ami-c6d241d0';   // A custom made ami to speed up the buildout process   24

// Fetched 2017-04-18`
//us-east-1  xenial   16.04 LTS  amd64  hvm:ebs-ssd  20170414  ami-80861296  hvm
//us-east-2  xenial   16.04 LTS  amd64  hvm:ebs-ssd  20170414  ami-618fab04  hvm
//us-east-1  trusty   14.04 LTS  amd64  hvm:ebs-ssd  20170405  ami-772aa961  hvm
//us-east-1  precise  12.04 LTS  amd64  hvm:ebs-ssd  20170417  ami-0818881e  hvm
amis.us_east_1.precise  = 'ami-0818881e';
amis.us_east_1.trusty   = 'ami-772aa961';
amis.us_east_1.xenial   = 'ami-80861296';

// Our Trusties, based on the above
amis.us_east_1.trusty2  = 'ami-c91589df';   // A custom made ami to speed up the buildout process   25
amis.us_east_1.xenial2  = 'ami-e1126ff7';   // A custom made ami to speed up the buildout process   26




_.each(amis, function(value, region) {
  amis[region.replace(/_/g, '-')] = value;
});

raEc2 = ra.wrap(libEc2);
sg.exportify(module, libEc2);

if (process.argv[1] === __filename) {
  var userdata = getUserdata0_('scotty', 'TOAD', {
    TOAD_SERVICE : 'web',
    TOAD_STACK   : 'cnb',
    TOAD_TIER    : 'web'
  });

  console.log(userdata);
}

// AWS names:
//  us-east-1         N.Virginia    low-cost    $0.239 / hour for m4.xlarge
//  us-west-2         Oregon        low-cost    $0.239 / hour for m4.xlarge
//  us-west-1         N.Cal                     $0.279 / hour for m4.xlarge
//  ap-northeast-2    Seoul                     $0.331 / hour for m4.xlarge
//  ap-southeast-1    Singapore                 $0.335 / hour for m4.xlarge
//  ap-southeast-2    Sydney                    $0.336 / hour for m4.xlarge
//  ap-south-1        Mumbai                    $0.337 / hour for m4.xlarge
//  ap-northeast-1    Tokyo                     $0.348 / hour for m4.xlarge

/**
 *  Compute the default configuration, given the argv.
 */
function defLaunchConfig(options_) {
  var options       = options_ || {};
  var launchConfig  = {};

  var region, userData, acct, instanceProfile;

  // See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#runInstances-property

  // Make sure we have the minimum
  region                                                  = argvGet(options, 'region')                              || 'us-east-1';

  // ----- Required -----
  launchConfig.MinCount                                   = argvGet(options, 'min-count,min')                       || 1;
  launchConfig.MaxCount                                   = argvGet(options, 'max-count,max')                       || 1;

  setOn(launchConfig, 'Monitoring.Enabled',                 argvGet(options, 'monitoring')                          || true);

  launchConfig.ImageId                                    = argvGet(options, 'image-id')                            || amis[region].trusty;

  // The caller may have set argv.image-id to "precise" for example
  if (amis[region][launchConfig.ImageId]) {
    launchConfig.ImageId = amis[region][launchConfig.ImageId];
  }

  // ----- Highly Recommended -----

  setOn(launchConfig, 'KeyName',                            argvGet(options, 'key-name,key'));
  setOn(launchConfig, 'InstanceType',                       argvGet(options, 'instance-type'));
  setOn(launchConfig, 'InstanceInitiatedShutdownBehavior',  argvGet(options, 'shutdown-behavior'));
  setOn(launchConfig, 'DisableApiTermination',              argvGet(options, 'api-termination'));         // Not safe, but also not annoying
  setOn(launchConfig, 'Placement.Tenancy',                  argvGet(options, 'placement'));
  setOn(launchConfig, 'Placement.AvailabilityZone',         argvGet(options, 'availability-zone,zone'));

  // ----- Optional -----
  setOn(launchConfig, 'DryRun',                             argvGet(options, 'dry-run'));

  if ((acct = argvGet(options, 'account,acct')) && (instanceProfile = argvGet(options, 'instance-profile'))) {
    setOn(launchConfig, 'IamInstanceProfile.Arn',           'arn:aws:iam::'+acct+':instance-profile/'+instanceProfile);
  }

  if ((userData = argvGet(options, 'user-data'))) {
    launchConfig.UserData                                 = new Buffer(userData).toString('base64');
  }

  return launchConfig;
}

function blockDevice(devName, size) {
  return {
    DeviceName              : path.join('/dev', devName),
    Ebs : {
      VolumeSize            : size,
      VolumeType            : 'gp2',
      DeleteOnTermination   : true
    }
  };
}

/**
 *  The userdata for when starting an instance from a base-image.
 *
 *  Basically, it renames the default 'ubuntu' user to 'scotty'; manages
 *  /etc/hosts, and sets a couple of system-wide env vars.
 */
function getUserdata0_(username, upNamespace, envVars_, origUsername) {
  var envVars = cleanEnvVars(upNamespace, envVars_);

  var script  = [
                "#!/bin/bash -ex",
         format("if ! [ -d /home/%s ]; then", username),
         format("  usermod -l %s %s", username, origUsername),
         format("  groupmod -n %s %s", username, origUsername),
         format("  usermod  -d /home/%s -m %s", username, username),
                "fi",

         format("if [ -f /etc/sudoers.d/90-cloudimg-%s ]; then", origUsername),
         format("  mv /etc/sudoers.d/90-cloudimg-%s /etc/sudoers.d/90-cloud-init-users", origUsername),
                "fi",
         format("perl -pi -e 's/%s/%s/g;' /etc/sudoers.d/90-cloud-init-users", origUsername, username),

                "if ! grep `hostname` /etc/hosts; then",
                "  echo \"127.0.0.1 `hostname`\" | sudo tee -a /etc/hosts",
                "fi",
                ""
  ];
  _.each(envVars, function(value, key) {
    script.push("echo "+key+"="+value+" | sudo tee -a /etc/environment");
  });
  script.push(  "");

  return script;
}

function getUserdata0(username, upNamespace, envVars, origUsername) {
  var script = getUserdata0_(username, upNamespace, envVars, origUsername);
  return new Buffer(sg.lines(script)).toString('base64');
}

/**
 *  The userdata for when starting an instance from a created AMI.
 *
 */
function getUserdataForAmi_(username, upNamespace, envVars_, origUsername) {
  var envVars = cleanEnvVars(upNamespace, envVars_);

  var script  = [
                "#!/bin/bash -ex",
                ""
  ];
  _.each(envVars, function(value, key) {
    script.push("/usr/local/bin/yoshi-set-env "+key+" "+value);
  });
  script.push(  "");

  return script;
}

function getUserdataForAmi(username, upNamespace, envVars, origUsername) {
  var script = getUserdataForAmi_(username, upNamespace, envVars, origUsername);
  return new Buffer(sg.lines(script)).toString('base64');
}

function cleanEnvVars(upNamespace, envVars_) {
  var envVars = {};
  _.each(envVars_, function(value, key) {
    envVars[key] = value;
    if (upNamespace !== 'MARIO' && key.indexOf(upNamespace) !== -1) {
      envVars[key.replace(upNamespace, 'MARIO')] = value;
    }
  });

  return envVars;
}

function giantWarning(msg) {
  console.error("============================================================================================");
  console.error("============================================================================================");
  console.error("========= "+msg);
  console.error("============================================================================================");
  console.error("============================================================================================");
}

function getClassB(cidrBlock) {
  return +cidrBlock.split(/[^0-9]/)[1];
}

function instanceStats(ip) {
  var result = {};
  var parts  = ip.split(/[^0-9]/);
  var classb = +parts[1];
  var octet3 = +parts[2];
  var octet4 = +parts[3];

  if (octet3 === 0)           { result.color = 'green'; }
  else if (octet3 === 1)      { result.color = 'blue'; }
  else if (octet3 === 2)      { result.color = 'teal'; }
  else if (octet3 === 3)      { result.color = 'yellow'; }
  else if (octet3 === 21)     { result.color = 'green'; }
  else if (octet3 === 22)     { result.color = 'blue'; }
  else if (octet3 === 23)     { result.color = 'teal'; }
  else if (octet3 === 24)     { result.color = 'yellow'; }

  if (octet4 < 4)             { result.service = 'bastion'; }
  else if (octet4 < 10)       { result.service = 'util'; }
  else if (octet4 < 16)       { result.service = 'web'; }
  else if (octet4 < 100)      { result.service = 'rip'; }
  else if (octet4 < 200)      { result.service = 'netapp'; }
  else if (octet4 < 220)      { result.service = 'controller'; }
  else if (octet4 < 251)      { result.service = 'db'; }
  else if (octet4 < 255)      { result.service = 'admin'; }

  if (classb === 10)          { result.stack = 'pub';       result.domainName = 'mobilewebprint.net'; }
  else if (classb === 11)     { result.stack = 'cluster';   result.domainName = 'mobiledevprint.net'; }
  else if (classb === 19)     { result.stack = 'test';      result.domainName = 'mobiledevprint.net'; }
  else if (classb === 21)     { result.stack = 'develop';   result.domainName = 'mobiledevprint.net'; }
  else if (classb === 23)     { result.stack = 'burn';      result.domainName = 'mobiledevprint.net'; }
  else if (classb === 24)     { result.stack = 'burn2';     result.domainName = 'mobiledevprint.net'; }
  else if (classb === 25)     { result.stack = 'burn3';     result.domainName = 'mobiledevprint.net'; }
  else if (classb === 26)     { result.stack = 'burn4';     result.domainName = 'mobiledevprint.net'; }

  result.fqdn               = result.stack+'.'+result.domainName;

  if (octet4 >= 10 && octet4 < 15 && result.color) {
    result.fqdn   = result.color+'-'+result.fqdn;
  }

  return result;
}

function nameScore(name) {
  var score = 0;

  // No color: += 0
  if (name.match(/^green/i))                { score += 1000; }
  else if (name.match(/^blue/i))            { score += 2000; }
  else if (name.match(/^teal/i))            { score += 3000; }
  else if (name.match(/^yellow/i))          { score += 4000; }

  // pub += 0
  if (name.match(/test[0-9]\./i))           { score += 100; }
  else if (name.match(/dev[0-9]\./i))       { score += 200; }
  else if (name.match(/cnb3\./i))           { score += 300; }
  else if (name.match(/cnb4\./i))           { score += 400; }
  else if (name.match(/cnb5\./i))           { score += 500; }
  else if (name.match(/cluster\./i))        { score += 900; }

  return score;
}

function mkPromoteCmd(subdomain, domain_, instanceId) {

  var isProd = !!subdomain.match(/pub/i);
  var domain = isProd ? 'mobilewebprint.net' : 'mobiledevprint.net';

  // Exception -- hq is not in prod, but is mobilewebprint
  if (subdomain === 'hq') {
    domain = 'mobilewebprint.net';
  }

  var cmd = './assignFqdnToInstance --instance-id='+instanceId+' --fqdn='+subdomain+'.'+domain;

  if (isProd) {
    cmd += ' --session=prod --acct=244406501905 --role=mario-mobilewebprint';
  }

  return cmd;
}

