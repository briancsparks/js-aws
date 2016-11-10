
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

/**
 *
 *  aws route53 list-resource-record-sets --hosted-zone-id 'mobiledevprint.net.'
 */
libRoute53.list2ResourceRecordSets = function(argv, context, callback) {
  argv                    = jsaws.prep(argv);
  var aws2Route53         = jsaws.get2Route53(argv);
  var awsRoute53          = aws2Route53.service;
  var awsForeignRoute53   = aws2Route53.foreignService;

  var zoneId              = argvExtract(argv, 'zone-id');
  var zoneName            = argvExtract(argv, 'zone-name');

  var zone2Id             = argvExtract(argv, 'zone2-id');
  var zone2Name           = argvExtract(argv, 'zone2-name');

  var die         = sg.__mkDiell(callback);
  var recordSets  = {ResourceRecordSets:[]};
  return sg.__runll([function(next) {

    // Get the local data
    if (!zoneId && !zoneName) { return next(); }

    return sg.__run([function(next1) {

      // Get the zoneId
      if (zoneId)   { return next1(); }

      /* otherwise */
      return raRoute53.listHostedZones(argv, context, function(err, zones) {
        if (err)          { return die(err, 'list2ResourceRecordSets.listHostedZones'); }

        _.each(zones.HostedZones, function(zone) {
          if (deref(zone, 'Config.PrivateZone') === false) {
            if (deref(zone, 'Name') === zoneName) {
              zoneId = deref(zone, 'Id');
            }
          }
        });

        if (!zoneId) { return die(sg.toError("Cannot determine zoneId"), 'list2ResourceRecordSets.listHostedZones(no-zone-id)'); }

        return next1();
      });

    }], function() {
      return awsRoute53.listResourceRecordSets({HostedZoneId: zoneId}, function(err, recordSets_) {
        if (err)          { return die(err, 'list2ResourceRecordSets.listResourceRecordSets'); }

        _.each(recordSets_.ResourceRecordSets, function(value, key) {
          recordSets.ResourceRecordSets.push(value);
        });

        return next();
      });
    });
  }, function(next) {

    // Get the local data
    if (!zone2Id && !zone2Name) { return next(); }

    return sg.__run([function(next2) {

      // Get the zone2Id
      if (zone2Id)   { return next2(); }

      /* otherwise */
      return awsForeignRoute53('listHostedZones', function(err, zones) {
        if (err)          { return die(err, 'list2ResourceRecordSets.foreign.listHostedZones'); }

        _.each(zones.HostedZones, function(zone) {
          if (deref(zone, 'Config.PrivateZone') === false) {
            if (deref(zone, 'Name') === zone2Name) {
              zone2Id = deref(zone, 'Id');
            }
          }
        });

        if (!zone2Id) { return die(sg.toError("Cannot determine zone2Id"), 'list2ResourceRecordSets.foreign.listHostedZones'); }

        return next2();
      });

    }], function() {
      return awsForeignRoute53('listResourceRecordSets', {HostedZoneId: zone2Id}, function(err, recordSets_) {
        if (err)          { return die(err, 'list2ResourceRecordSets.foreign.listHostedZones'); }

        _.each(recordSets_.ResourceRecordSets, function(value, key) {
          recordSets.ResourceRecordSets.push(value);
        });

        return next();
      });
    });

  }], function() {
    return callback(null, recordSets);
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



