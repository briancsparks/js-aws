
/**
 *  JS-ification of Route 53.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var aws                 = require('aws-sdk');
var jsaws               = require('../jsaws');
var ra                  = require('run-anywhere');
var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;
var deref               = sg.deref;

var raRoute53;                /* Gets build from the libEc2 object at the end of this file */

var libRoute53          = {};

/**
 *
 */
libRoute53.listHostedZones = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsRoute53    = jsaws.getRoute53(argv);

  return awsRoute53.listHostedZones(function(err, zones) {
    return callback(err, zones);
  });
};

/**
 *
 *  aws route53 list-resource-record-sets --hosted-zone-id 'mobiledevprint.net.'
 */
libRoute53.listResourceRecordSets = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsRoute53    = jsaws.getRoute53(argv);

  var zoneId        = argvExtract(argv, 'zone-id');
  var zoneName      = argvExtract(argv, 'zone-name');

  return sg.__run([function(next) {
    if (zoneId) { return next(); }

    return raRoute53.listHostedZones(argv, context, function(err, zones) {
      if (err)          { return callback(err); }

      _.each(zones.HostedZones, function(zone) {
        if (deref(zone, 'Config.PrivateZone') === false) {
          if (deref(zone, 'Name') === zoneName) {
            zoneId = deref(zone, 'Id');
          }
        }
      });

      if (!zoneId) { return callback(sg.toError("Cannot determine zoneId")); }

      return next();
    });

  }], function() {
    return awsRoute53.listResourceRecordSets({HostedZoneId: zoneId}, function(err, recordSets) {
      return callback(err, recordSets);
    });
  });
};

libRoute53.r53Describe = function(argv, context, callback) {
  var funcname      = argvExtract(argv, 'funcname,name');
  var funcargs      = argvExtract(argv, 'args')             || [{}];

  argv              = jsaws.prep(argv);
  var awsRoute53    = jsaws.getRoute53(argv);

  if (!awsRoute53[funcname]) { return callback(sg.toError('No such function')); }

  funcargs.push(function(err, data) {
    return callback(err, data);
  });

  return awsRoute53[funcname].apply(awsRoute53, funcargs);
};

raRoute53 = ra.wrap(libRoute53);
_.each(libRoute53, function(value, key) {
  exports[key] = value;
});



