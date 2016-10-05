
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

var jsVpc               = ra.require('./vpc', __dirname);
var jsEc2;

var getConfig           = jsaws.getConfig;
var getAll              = jsaws.getAll;
var getX2               = jsaws.getX2;
var argvGet             = sg.argvGet;
var firstKey            = sg.firstKey;
var deref               = sg.deref;
var setOn               = sg.setOn;
var die                 = sg.die;
var numKeys             = sg.numKeys;
var isInCidrBlock       = helpers.isInCidrBlock;
//var log                 = helpers.log;
var format              = util.format;

var ec2 = {};

/**
 *  Launch an AWS instance.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
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
ec2.runInstance = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);
  var log           = sg.mkLogger(argv);

  // All the stuff we will figure out in the sg.__run() callbacks
  var ip, tier, service, serviceType, namespace, stack, launchConfig_, numTriesLeft, instanceName, octets, serviceNum;

  // How many times will we try go find a non-used IP address?
  numTriesLeft      = argvGet(argv, 'num-tries,tries')  || 10;

  // Do we have a forced IP address?
  if ((ip = argvGet(argv, 'force-ip'))) {
    numTriesLeft = 0;
  }

  // Make sure we have a private IP address
  if (!ip && !(ip = argvGet(argv, 'ip'))) { return die('No internal IP address', callback, 'runInstance'); }

  // Get user options
  octets            = ip.split('.');
  namespace         = argvGet(argv, 'namespace')        || 'jsaws';
  tier              = argvGet(argv, 'tier')             || getConfig('tierForIp', ip)         || 'app';
  service           = argvGet(argv, 'service')          || getConfig('serviceForIp', ip)      || 'app';
  serviceType       = argvGet(argv, 'serviceType')      || getConfig('serviceTypeForIp', ip)  || 'app';
  serviceNum        = 0;

  // Get the default launch configuration (and use the passed-in argv)
  launchConfig_     = defLaunchConfig(argv);

  // The things that are found
  var vpc, subnet, securityGroups, ownerId, reservations;

  // See if the args provide some of them
  ownerId = argvGet(argv, 'owner-id,owner') || ownerId;

  log('Launching instance');
  return sg.__run([function(next) {

    // ----- Get the VPC, given the IP address, and the stack, and compute the instance name.
    return jsVpc.vpcsForIp({ip:ip}, {}, function(err, vpcs) {
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
      return jsVpc.getSubnets(function(err, subnets_) {
        if (err) { return die(err, callback, 'runInstance.getSubnets'); }

        var subnets = _.filter(subnets_, function(subnet, id) {
          return isInCidrBlock(ip, subnet.CidrBlock) && (subnet.VpcId === vpc.VpcId);
        });
        if (numKeys(subnets) !== 1)    { return die('Found '+numKeys(subnets)+' subnets, needs to be only one.', callback, 'runInstance.getSubnets'); }

        subnet = subnets[0];
        log('using subnet', subnet.SubnetId);

        return next();
      });

    }, function(next) {

      // ----- How does this new instance fit in with the already-existing instances?
      return jsEc2.getInstances(function(err, instances) {
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
      return jsVpc.getSecurityGroups(function(err, securityGroups_) {
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

    }], function() {

      return sg.__run([function(next) {

        // TODO: Should use sg.until()
        return once();
        function once() {

          // ----- Build up the configuration
          var launchConfig = sg.deepCopy(launchConfig_);

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

          // ----- Other -----
          launchConfig.InstanceType   = launchConfig.InstanceType || 't2.large';
          launchConfig.KeyName        = launchConfig.KeyName      || namespace+'_demo';
          launchConfig.UserData       = userdata(argvGet(argv, 'username,user') || 'scotty');

          if (ownerId && namespace && service) {
            // TODO: put service back
            //setOn(launchConfig, 'IamInstanceProfile.Arn',   'arn:aws:iam::'+ownerId+':instance-profile/'+[namespace, service, 'instance-role'].join('-'));
            setOn(launchConfig, 'IamInstanceProfile.Arn',   'arn:aws:iam::'+ownerId+':instance-profile/'+[namespace, 'app', 'instance-role'].join('-'));
          }

          // Launch
          log('done collecting info... trying to launch', launchConfig.InstanceType, ip);
          return awsEc2.runInstances(launchConfig, function(err, reservations_) {
            if (err) {

              // if the IP address is already in use, this is not an error
              if (err.code === 'InvalidIPAddress.InUse' && numTriesLeft > 0) {
                ip = helpers.nextIp(ip);
                numTriesLeft -= 1;
                return once();
              }

              // Log if this is a dry-run
              if (err.code === 'DryRunOperation') {
                log('dry-run', err, launchConfig);
                return callback();
              }

              // OK, this is an error
              log("Error - here is the launch config", launchConfig);
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
        var createTagsParams = {Resources : _.pluck(reservations.Instances, 'InstanceId'), Tags : []};

        createTagsParams.Tags.push({Key:'Name', Value:instanceName});

        // Tagging might fail, if so, try again
        var ctResult;
        return sg.until(function(again, last, count) {
          if (count > 5) { return last(); }

          return awsEc2.createTags(createTagsParams, function(err, result) {
            log('tagging', err, createTagsParams.Resources);
            if (err) {
              console.error('createTags err', err);
              return again(250);
            }

            ctResult = result;
            return last();
          });
        }, function() {
          log('createTags result', ctResult);
          return next();
        });
      }], function() {

        // Return now, if the caller does not want to wait for the instance to be running
        if (argvGet(argv, 'no-wait,nowait')) {
          return callback(null, reservations);
        }

        /* otherwise -- wait for it to be running */
        var waitArgv = {
          instanceId  : _.pluck(reservations.Instances, 'InstanceId'),
          state       : 'running'
        };

        return jsEc2.waitForInstanceState(_.extend(waitArgv, argv), context, function(err, instances) {
          return callback(null, instances /*, reservations*/);
        });
      });
    });
  });
};

/**
 *  Wait for the instances to be in the requested state.
 */
var waitForInstanceState = ec2.waitForInstanceState = function(argv, context, callback) {
  var instanceId  = argvGet(argv, 'instance-id,id');
  var state       = argvGet(argv, 'state')      || 'available';
  var timeout     = (argvGet(argv, 'timeout')   || 90) * 1000;

  var log         = sg.mkLogger(argv);

  log('waiting for', instanceId);

  var diParams = {
    InstanceIds      : _.isArray(instanceId) ? instanceId : [instanceId]
  };

  // Wait until we get success from getInstances, and we are in the right state.
  return sg.until(function(again, last, count, elapsed) {
    if (count > 200 || elapsed > timeout) { return callback('Waited too long for image state.'); }
    return jsEc2.getInstances(diParams, {}, function(err, instances) {
      if (err) { return again(500); }

      var all = _.all(instances, function(instance) { return deref(instance, 'State.Name') === state; });
      if (!all) { return again(500); }

      // They are all in the right state
      return last(null, instances);
    });
  }, function(err, instances) {
    return callback(err, instances);
  });
};

/**
 *  The JS-ification of the EC2 createImage API.
 */
var createAmi = ec2.createAmi = function(argv, context, callback) {
  var ciParams = {
    NoReboot      : false,
    InstanceId    : argvGet(argv, 'instance-id'),
    Name          : argvGet(argv, 'name'),
    Description   : argvGet(argv, 'description')
  };

  // Call the raw createImage function
  return jsEc2.createImage(ciParams, {}, function(err, results) {
    if (err) { return die(err, callback, 'createAmi.createImage'); }

    return waitForImageState({id:results.ImageId}, {}, function(err, images) {
      log('images returned from createImage: ', images);
      return callback(err, images);
    });
  });
};

/**
 *  Wait for the AMI created image to be in the desired state.
 */
var waitForImageState = ec2.waitForImageState = function(argv, context, callback) {
  var imageId = argvGet(argv, 'image-id,id');
  var state   = argvGet(argv, 'state')      || 'available';
  var timeout = (argvGet(argv, 'timeout')   || 60) * 1000;

  var diParams = {
    ImageIds      : _.isArray(imageId) ? imageId : [imageId]
  };

  return sg.until(function(again, last, count, elapsed) {
    if (count > 200 || elapsed > timeout) { return callback('Waited too long for image state.'); }

    return getImages(diParams, {}, function(err, images) {
      if (err) { return again(500); }

      console.log(_.pluck(images, 'State'));
      var all = _.all(images, function(image) { return image.State === state; });
      if (!all) { return again(500); }

      // They are all in the right state
      return last(null, images);
    });
  }, function(err, images) {
    return callback(err, images);
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
var createImage = ec2.createImage = function(argv, context, callback) {
  var ciParams = _.pick(argv, 'NoReboot', 'InstanceId', 'Name', 'Description');
  return ec2.createImage(ciParams, function(err, result) {
    if (err) { return die(err, callback, 'createImage.createImage'); }

    return callback(null, result);
  });
};

// --------------------------------------------------------------------------------------
//    EC2 describe* APIs (but we use 'get' style)
// --------------------------------------------------------------------------------------

var getVolumes = ec2.getVolumes = function(argv, context, callback) {
  return getAll(argv, context, callback, 'Volumes');
};

var getImages = ec2.getImages = function(argv_, context, callback) {
  var argv = _.extend({Owners:['self']}, argv_ || {});
  return getX2(argv, context, callback, 'Images');
};

var getInstances = ec2.getInstances = function(argv, context, callback) {
  return getX2(argv, context, function(err, reservations) {
    if (err) { return callback(err); }

    var result = {};
    sg.eachFrom(reservations.Reservations, "Instances", function(instance, instanceId) {
      result[instanceId] = instance;
    });

    return callback(null, result);
  }, 'Instances');
};

// From: https://cloud-images.ubuntu.com/locator/ec2/
// hvm:ebs-ssd updated 2016-09-14
var amis = {

  // N.Varginia -- Search with 'us-east-1 ebs-ssd amd64 lts'
  us_east_1: {
    precise : 'ami-e4caa5f3',
    trusty  : 'ami-8e0b9499',
    xenial  : 'ami-2ef48339'
  },

  // Tokyo -- Search with 'ap-northeast-1 ebs-ssd amd64 lts'
  ap_northeast_1: {
    precise : 'ami-2ef53d4f',
    trusty  : 'ami-49d31328',
    xenial  : 'ami-0919cd68'
  }
};

_.each(amis, function(value, region) {
  amis[region.replace(/_/g, '-')] = value;
});

jsEc2 = ra.wrap(ec2);
sg.exportify(module, ec2);

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
 *  Compute the default configuration for the argv.
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

  setOn(launchConfig, 'Monitoring.Enabled',                 argvGet(options, 'monitoring')                          || false);

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

function userdata(username) {
  var script = [
           "#!/bin/bash -ex",
    format("usermod -l %s ubuntu", username),
    format("groupmod -n %s ubuntu", username),
    format("usermod  -d /home/%s -m %s", username, username),

           "if [ -f /etc/sudoers.d/90-cloudimg-ubuntu ]; then",
           "  mv /etc/sudoers.d/90-cloudimg-ubuntu /etc/sudoers.d/90-cloud-init-users",
           "fi",
    format("perl -pi -e 's/ubuntu/%s/g;' /etc/sudoers.d/90-cloud-init-users", username),

           "if ! grep `hostname` /etc/hosts; then",
           "  echo \"127.0.0.1 `hostname`\" | sudo tee -a /etc/hosts",
           "fi",
           ""
  ];

  return new Buffer(sg.lines(script)).toString('base64');
}

