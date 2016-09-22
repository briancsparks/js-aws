
/**
 *
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
var getX                = jsaws.getX;

var vpc = {};

var getVpcs = vpc.getVpcs = function(argv, context, callback) {
  return getX(argv, context, callback, 'Vpcs');
};

var getSubnets = vpc.getSubnets = function(argv, context, callback) {
  return getX(argv, context, callback, 'Subnets');
};

var getRouteTables = vpc.getRouteTables = function(argv, context, callback) {
  return getX(argv, context, callback, 'RouteTables');
};

var getSecurityGroups = vpc.getSecurityGroups = function(argv, context, callback) {
  return getX(argv, context, callback, 'SecurityGroups');
};

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

