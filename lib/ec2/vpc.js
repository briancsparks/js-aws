
/**
 *  Handles VPC information.
 */
var sg                  = require('sgsg');
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var helpers             = require('../helpers');
var awsJsonLib          = require('aws-json');

var _                   = sg._;
var argvGet             = sg.argvGet;
var deref               = sg.deref;
var AwsJson             = awsJsonLib.AwsJson;
var isInCidrBlock       = helpers.isInCidrBlock;
var getAll              = jsaws.getAll;

var vpc = {};

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
  return getVpcs(argv, context, function(err, vpcs) {
    if (err) { return callback(err); }

    var result = sg._reduce(deref(vpcs, 'Vpcs') || vpcs, {}, function(m, vpc, vpcId) {
      if (isInCidrBlock(argv.ip, vpc.CidrBlock)) { return sg.kv(m, vpcId, vpc); }
      return m;
    });

    return callback(null, result);
  });
};

sg.exportify(module, vpc);

