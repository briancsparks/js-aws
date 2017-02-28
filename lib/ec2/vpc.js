
/**
 *  Handles VPC information.
 */
var sg                  = require('sgsg');
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var helpers             = require('../helpers');
var awsJsonLib          = require('aws-json');
var awsService          = require('../service/service');

var _                   = sg._;
var argvGet             = sg.argvGet;
var deref               = sg.deref;
var AwsJson             = awsJsonLib.AwsJson;
var isInCidrBlock       = helpers.isInCidrBlock;
var get2All             = jsaws.get2All;
var makeEachFn          = jsaws.makeEachFn;
var makeFilterFn        = jsaws.makeFilterFn;

var vpc = {};

/**
 *  Invoke one of the describe-X functions.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} callback    - Run-anywhere style callback.
 *  @param {string} awsName       - The name of the thing to be described, like "Instances".
 *  @param {string} [awsFnName]   - Sometimes, you cannot just paste "describe"+awsName to get the right function.
 */
var getAll = function(argv, context, callback, awsName, awsFnName_) {
  var awsFnName       = awsFnName_ || 'describe'+awsName;

  // Did the caller pass in information for a different account?
  var roleSessionName = argvGet(argv, 'role_session_name,session') || 'main';
  var acct            = argvGet(argv, 'account,acct');
  var role            = argvGet(argv, 'role');
  var region          = argvGet(argv, 'region');

  // The AWS EC2 service
  var awsEc2          = awsService('EC2', roleSessionName, acct, role, region);

  var result;
  return sg.until(function(again, last) {
    return awsEc2[awsFnName](function(err, x) {
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

/**
 *  Get all VPCs in the account.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 */
var getVpcs = vpc.getVpcs = function(argv, context, callback) {
  return getAll(argv, context, callback, 'Vpcs');
};

var get2Vpcs = vpc.get2Vpcs = function(argv, context, callback) {
  return get2All(argv, context, callback, 'Vpcs');
};

vpc.eachVpc     = makeEachFn(getVpcs);
vpc.filterVpcs  = makeFilterFn(getVpcs);

/**
 *  Enumerate each VPC in the account.
 */
vpc.eachVpc2 = function(fn, callback) {
  return getVpcs({}, {}, function(err, vpcs) {
    if (err) { return callback(err); }

    _.each(vpcs, function(vpc) {
      return fn.apply(this, arguments);
    });

    return callback();
  });
};

/**
 *  Get all Subnets in the account.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 */
var getSubnets = vpc.getSubnets = function(argv, context, callback) {
  return getAll(argv, context, callback, 'Subnets');
};

/**
 *  Get all RouteTables in the account.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 */
var getRouteTables = vpc.getRouteTables = function(argv, context, callback) {
  return getAll(argv, context, callback, 'RouteTables');
};

/**
 *  Get all SecurityGroups in the account.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 */
var getSecurityGroups = vpc.getSecurityGroups = function(argv, context, callback) {
  return getAll(argv, context, callback, 'SecurityGroups');
};

/**
 *  Gets the VPC that contains the IP address.
 *
 *  @param {Object} argv          - Run-anywhere style argv object.
 *  @param {Object} context       - Run-anywhere style context object.
 *  @param {Function} context     - Run-anywhere style callback.
 */
vpc.vpcsForIp = function(argv, context, callback) {
  // TODO: ra-ify this, like Ec2 does
  return getVpcs(argv, context, function(err, vpcs) {
    if (err) { return callback(err); }

    var result = sg._reduce(deref(vpcs, 'Vpcs') || vpcs, {}, function(m, vpc, vpcId) {
      if (isInCidrBlock(argv.ip, vpc.CidrBlock)) { return sg.kv(m, vpcId, vpc); }
      return m;
    });

    return callback(null, result);
  });
};

vpc.awsEnumerators = function() {
  return {
    all: {
      "AWS::EC2::VPC"  : vpc.getVpcs
    }
  };
};

sg.exportify(module, vpc);

