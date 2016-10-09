
var sg            = require('sgsg');
var _             = require('underscore');

var libHelpers    = {};

/**
 *    Returns the string ip address into a Number.
 *
 *    For use with subnet masks.
 */
var ipNumber = libHelpers.ipNumber = function(ip_) {
    var ip = ip_.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if(ip) {
        return (+ip[1]<<24) + (+ip[2]<<16) + (+ip[3]<<8) + (+ip[4]);
    }
    // else ... ?
    return 0;
};

var dottedIp = libHelpers.dottedIp = function(n) {
  return [n >> 24, (n & 0xffffff) >> 16, (n & 0xffff) >> 8, n & 0xff].join('.');
};

libHelpers.isInCidrBlock = function(ip, cidr) {
  var parts = cidr.split('/');
  return (ipNumber(ip) & ipMask(parts[1])) == ipNumber(parts[0]);
};

libHelpers.nextIp = function(ip) {
  return dottedIp(ipNumber(ip) + 1);
};

libHelpers.prevIp = function(ip) {
  return dottedIp(ipNumber(ip) - 1);
};

var firstIpInCidrBlock = libHelpers.firstIpInCidrBlock = function(cidr) {
  var parts       = cidr.split('/');
  var minNumber   = ipNumber(parts[0]) & ipMask(parts[1]);
  return dottedIp(minNumber);
};

var lastIpInCidrBlock = libHelpers.lastIpInCidrBlock = function(cidr) {
  var parts       = cidr.split('/');
  var maxNumber   = ipNumber(parts[0]) | ~ipMask(parts[1]);
  return dottedIp(maxNumber);
};

libHelpers.nextCidrBlockOfSize = function(cidrBlock_, newNumBits) {

  var lastForOld  = ipNumber(lastIpInCidrBlock(cidrBlock_));
  var lastForNew  = ipNumber(lastIpInCidrBlock(cidrBlock_.replace(/\/[0-9]+$/g, '/'+newNumBits)));
  var firstOfNext = Math.max(lastForOld, lastForNew) + 1;

  return dottedIp(firstOfNext)+'/'+newNumBits;
};

var capitalizeFirstLetter = libHelpers.capitalizeFirstLetter = function(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 *  Returns the camel-case version of the string.
 *
 *  instance_type --> instanceType
 *  instance-type --> instanceType
 */
var toCamelCase = libHelpers.toCamelCase = function(key) {
  var parts = _.chain(key.split('.')).map(function(x) { return x.split(/[-_]/g); }).flatten().value();
  var result  = parts.shift();

  _.each(parts, function(s) {
    result += capitalizeFirstLetter(s);
  });

  return result;
};

var toCapitalCase = libHelpers.toCapitalCase = function(key) {
  return capitalizeFirstLetter(toCamelCase(key));
};

libHelpers.log = function() {
  return;
  _.each(_.toArray(arguments), function(arg) {
    process.stderr.write(sg.inspect(arg));
    if (!_.isString(arg)) {
      process.stderr.write('\n');
    }
  });
  process.stderr.write('\n');
};

/**
 *    Returns the mask size as a Number.
 *
 *    For use with subnet masks.
 */
function ipMask(maskSize) {
  return -1 << (32 - maskSize);
};

_.each(libHelpers, function(value, key) {
  exports[key] = value;
});


