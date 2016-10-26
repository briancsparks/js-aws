
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
var ra                  = require('run-anywhere');
var helpers             = require('../helpers');
var path                = require('path');
var util                = require('util');
var awsJsonLib          = require('aws-json');

// run-anywhere-ified modules
var raVpc               = ra.require('./vpc', __dirname);
var raIam               = ra.require('../iam/iam', __dirname);
var raRoute53           = ra.require('../route-53/route-53', __dirname);

var raEc2;                /* Gets build from the libEc2 object at the end of this file */

// Sub-object functions
var getConfig           = jsaws.getConfig;
var getAll              = jsaws.getAll;
var getX2               = jsaws.getX2;
var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;
var firstKey            = sg.firstKey;
var deref               = sg.deref;
var setOn               = sg.setOn;
var die                 = sg.die;
var numKeys             = sg.numKeys;
var isInCidrBlock       = helpers.isInCidrBlock;
var addTag              = awsJsonLib.addTag;
var toAwsTags           = awsJsonLib.toAwsTags;
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
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);
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
  var dbIp              = argvGet(argv, 'db-ip,db')                   || '10.11.22.220';
  var utilIp            = argvGet(argv, 'util-ip,util')               || '10.11.22.4';
  var testDbIp          = argvGet(argv, 'test-db-ip,test-db')         || [octets[0], octets[1], octets[2], 220].join('.');
  var testUtilIp        = argvGet(argv, 'test-util-ip,test-util')     || [octets[0], octets[1], octets[2], 4].join('.');
  var username          = argvGet(argv, 'username')                   || 'scotty';
  var origUsername      = argvGet(argv, 'orig-username')              || 'ubuntu';

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
      namespace   : namespace,
      tier        : tier,
      service     : service,
      serviceType : serviceType,
      build       : buildNumber,
      color       : color,
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
    return raVpc.vpcsForIp({ip:ip}, context, function(err, vpcs) {
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
      return raVpc.getSubnets(function(err, subnets_) {
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
      return raVpc.getSecurityGroups(function(err, securityGroups_) {
        if (err) { return die(err, callback, 'runInstance.getSubnets'); }

        securityGroups = _.filter(securityGroups_, function(securityGroup, id) {
          var applyToServices = deref(securityGroup, "Tags."+namespace+".applyToServices");

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

      return raIam.getInstanceProfile({role:[namespaceEx, service, 'instance-role'].join('-')}, context, function(err, arn) {
        if (err) {
          if (err.code !== 'NoSuchEntity')    { return die(err, callback, 'runInstance.getInstanceProfile1'); }

          // No such instance profile -- use the generic one
          return raIam.getInstanceProfile({role:[namespaceEx, '', 'instance-role'].join('-')}, context, function(err, arn) {
            if (err)    { return die(err, callback, 'runInstance.getInstanceProfile2'); }

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

          launchConfig.BlockDeviceMappings.push(blockDevice('sda1', 32));
          if (service === 'db') {
            launchConfig.BlockDeviceMappings.push(blockDevice('sdf', 300));
            launchConfig.BlockDeviceMappings.push(blockDevice('sdg', 25));
            launchConfig.BlockDeviceMappings.push(blockDevice('sdh', 10));
          } else {
            launchConfig.BlockDeviceMappings.push(blockDevice('sdf', 100));
          }

          // ----- Critical Startup Environment Variables -----
          buildoutEnvVars.NAMESPACE               = namespace;
          buildoutEnvVars[upNamespace+"_SERVICE"] = buildoutEnvVars.MARIO_SERVICE   = service;
          buildoutEnvVars[upNamespace+"_STACK"]   = buildoutEnvVars.MARIO_STACK     = stack;
          buildoutEnvVars[upNamespace+"_TIER"]    = tier;

          if (color)        { buildoutEnvVars[upNamespace+"_COLOR"]           = color; }
          if (buildNumber)  { buildoutEnvVars[upNamespace+"_BUILD"]           = buildNumber; }
          if (dbIp)         { buildoutEnvVars[upNamespace+"_DB_IP"]           = buildoutEnvVars.MARIO_DB_HOSTNAME       = dbIp; }
          if (utilIp)       { buildoutEnvVars[upNamespace+"_UTIL_IP"]         = utilIp; }
          if (testDbIp)     { buildoutEnvVars[upNamespace+"_TEST_DB_IP"]      = testDbIp; }
          if (testUtilIp)   { buildoutEnvVars[upNamespace+"_TEST_UTIL_IP"]    = testUtilIp; }

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

            return next();
          });
        }

      }, function(next) {

        // ----- Tag Instances -----
        var tagBuildNumber  = buildNumber;
        var diParams        = { ImageIds : [launchConfig.ImageId] };
        return raEc2.getImages(diParams, context, function(err, images) {

          // If the AMI has a build number, use it.
          if (!err && images) {
            _.each(images, function(image) {
              if (image.Tags && image.Tags[namespaceEx] && ('build' in image.Tags[namespaceEx])) {
                tagBuildNumber = +image.Tags[namespaceEx].build;
              }
            });
          }

          var Tags = [{Key:'Name', Value:instanceName}];
          if (namespace) {
            if (service)          { Tags.push({Key:[namespace, 'service'].join(':'), Value:service}); }
            if (tagBuildNumber)   { Tags.push({Key:[namespace, 'build'].join(':'),   Value:''+tagBuildNumber}); }
            if (color)            { Tags.push({Key:[namespace, 'color'].join(':'),   Value:color}); }
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

  var namespaceEx   = argvGet(argv, 'namespace,ns');
  var namespace     = namespaceEx.replace(/[0-9]+$/, '');

  return libEc2.runInstance(argv, context, function(err, instances, launchConfig) {
    if (err) { return die(err, callback, 'runInstanceFromAmi.runInstance'); }

    // Was that a web-instance, which might need to be pointed-to by a sub-domain name?
    var instance  = instances[firstKey(instances)];
    var privateIp = instance.PrivateIpAddress;
    var instStats = instanceStats(privateIp);

    if (instance && instance.Tags && instance.Tags[namespace]) {

      var service = instance.Tags[namespace].service  || instStats.service;
      var color   = instance.Tags[namespace].color    || instStats.color;
      var stack   = launchConfig.stack                || instStats.stack;

      if (service !== 'web')  { return callback(null, instances, launchConfig); }

      var params = {
        instance_id   : instance.InstanceId,
        fqdn          : instStats.fqdn
      };

      return raEc2.assignFqdnToInstance(params, context, function(err, result) {
        if (err) { return die(err, callback, 'runInstanceFromAmi.assignFqdnToInstances'); }
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
        console.error('createTags err', err, 'for', createTagsParams);
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

  var diParams = { InstanceIds : instanceIds };

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
  var buildNumber = nameParts[2];
  var service     = nameParts[3];

  // Call the raw, but ra-ified createImage function
  return raEc2.createImage(ciParams, context, function(err, results) {
    if (err) { return die(err, callback, 'createAmi.createImage'); }

    return raEc2.waitForImageState(_.extend({imageId:results.ImageId}, argv), context, function(err, images) {

      var tags  = pickTags(argv);
      tags.tags = tags.tags || {};
      tags.tags.Name = name;

      if (namespace) {
        if (buildNumber)    { tags.tags[namespace+':build'] = buildNumber; }
        if (stack)          { tags.tags[namespace+':stack'] = stack; }
      }

      // Space for the readyFor tag
      tags.tags[namespace+':readyFor'] = '';

      // If there are no tags, stop
//      if (_.keys(tags.tags).length === 0) { return callback(err, images); }

      /* otherwise -- tag it */
      var tiParams  = _.extend({id: results.ImageId}, tags);

      return raEc2.tagImage(tiParams, context, function(err, tagResults) {
        return callback(err, images);
      });
    });
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
  var instanceId  = argvExtract(argv, 'instance-id,id');
  var fqdn        = argvExtract(argv, 'fqdn');

  if (!instanceId)    { return callback(sg.toError("Need --instance-id")); }
  if (!fqdn)          { return callback(sg.toError("Need --fqdn")); }

  var domainName = [], subDomain;

  var parts       = fqdn.split('.');

  domainName.unshift(parts.pop());
  domainName.unshift(parts.pop());
  domainName = domainName.join('.');

  subDomain  = parts.join('.');
  var zones, addresses, instances;
  return sg.__runll([function(next) {
    return raRoute53.listHostedZones(argv, context, function(err, zones_) {
      if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.listHostedZones'); }
      zones = zones_;
      return next();
    });
  }, function(next) {
    return raEc2.getAddresses(argv, context, function(err, addresses_) {
      if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.getAddresses'); }
      addresses = addresses_;
      return next();
    });
  }, function(next) {
    return raEc2.getInstances({}, context, function(err, instances_) {
      if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.getInstances'); }
      instances = instances_;
      return next();
    });
  }], function() {
    var params = {
      zone_name : domainName+'.'
    };

    var ip, address;
    return raRoute53.listResourceRecordSets(params, context, function(err, recordSets) {
      if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.listResourceRecordSets'); }

      _.each(recordSets.ResourceRecordSets, function(recordSet) {
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
          var params = { AllocationId : address.AllocationId, InstanceId : instanceId};
          return raEc2.associateAddress(params, context, function(err, result) {
            if (err) { return die(err, callback, 'libEc2.assignFqdnToInstance.associateAddress'); }

            return callback(err, result);
          });
        }

        /* otherwise -- found IP, not address */
        return callback(sg.toError("Found IP, not Address: "+ip));
      }

      /* otherwise -- did not find IP address */
      return callback(sg.toError("Did not find IP"));
    });
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
  return raVpc.eachVpc(function(vpc) {

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
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);

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
        if (build.match(/^99/)) { return; }

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
 *    ra invoke lib/ec2/ec2.js getAmiIdsForBuild --namespace=ns3 --stack=dev3 --build-number=13
 */
libEc2.getAmiIdsForBuild = function(argv_, context, callback) {
  var argv          = sg.deepCopy(argv_);
  var namespace     = argvExtract(argv, 'namespace,ns');
  var stack         = argvExtract(argv, 'stack');
  var buildNumber   = +(argvExtract(argv, 'build-number,build-num,build') || '989999');

  if (!namespace) { return callback(sg.toError('Must provide namespace')); }

  if (stack)      { stack = stack.replace(/[0-9]+/, ''); }

  return raEc2.getImages(argv, context, function(err, images) {

    var results = {}, build, service, readyFor, ready;
    _.each(images, function(image) {
      if (image.ImageId && image.Tags[namespace] && ('build' in image.Tags[namespace]) && ('service' in image.Tags[namespace])) {
        service   = image.Tags[namespace].service;
        readyFor  = image.Tags[namespace].readyFor;
        build     = image.Tags[namespace].build;
        if (build.match(/^99/)) { return; }

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
      }
    });

    return callback(null, results);
  });
};

// ===================================================================================================
//    EC2 describe* APIs (but we use 'get' style)
// ===================================================================================================

libEc2.getVolumes = function(argv, context, callback) {
  return getAll(argv, context, callback, 'Volumes');
};

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
         format("usermod -l %s %s", username, origUsername),
         format("groupmod -n %s %s", username, origUsername),
         format("usermod  -d /home/%s -m %s", username, username),

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

  if (classb === 10)          { result.stack = 'pub3';    result.domainName = 'mobilewebprint.net'; }
  else if (classb === 11)     { result.stack = 'cluster'; result.domainName = 'mobiledevprint.net'; }
  else if (classb === 19)     { result.stack = 'test3';   result.domainName = 'mobiledevprint.net'; }
  else if (classb === 21)     { result.stack = 'dev3';    result.domainName = 'mobiledevprint.net'; }
  else if (classb === 23)     { result.stack = 'cnb3';    result.domainName = 'mobiledevprint.net'; }
  else if (classb === 24)     { result.stack = 'cnb4';    result.domainName = 'mobiledevprint.net'; }
  else if (classb === 25)     { result.stack = 'cnb5';    result.domainName = 'mobiledevprint.net'; }
  else if (classb === 26)     { result.stack = 'cnb6';    result.domainName = 'mobiledevprint.net'; }

  result.fqdn               = result.stack+'.'+result.domainName;

  if (octet4 >= 10 && octet4 < 15 && result.color) {
    result.fqdn   = result.color+'-'+result.fqdn;
  }

  return result;
}



