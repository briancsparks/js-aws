
/**
 *  Read info from various AWS APIs and put the info into MongoDB.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var jsMongo             = require('js-mongo');
var jsaws               = require('./jsaws');

var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;
var setOnMulti          = sg.setOnMulti;
var setOn               = sg.setOn;
var deref               = sg.deref;
var die                 = sg.die;
var getColl             = jsMongo.collection;
var eachDoc             = jsMongo.eachDoc;
var toArray             = jsMongo.toArray;

var dbHost              = '10.11.21.220';
var dbName              = 'aws_cluster';
var dbUrl               = 'mongodb://'+dbHost+':27017/'+dbName;

var collNames           = ['images', 'instances', 'vpcs', 'resourceRecordSets', 'addresses'];

var libCim = {};

libCim.clusterInMongo = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);
  var awsSns        = jsaws.getSns(argv);
  var awsIam        = jsaws.getIam(argv);
  var region        = argvExtract(argv, 'region');
  var awsRoute53    = jsaws.getRoute53(argv);

  var count         = argvExtract(argv, 'count');
  var skipRemove    = argvExtract(argv, 'skip-remove');

  var stats         = {deleted:0};
  var colls         = {};

  one();
  function one() {

    return sg.__run([function(next) {
      // Remove all data
      return sg.__eachll(collNames, function(collName, nextColl) {
        return getColl(dbUrl, collName, function(err, collection) {

          colls[collName] = collection;

          if (skipRemove) { return nextColl(); }

          return collection.deleteMany({}, function(err, receipt) {
            log('deleteMany: '+collName, err, _.pick(receipt, 'result', 'deletedCount'));
            stats.deleted  += deref(receipt, 'deletedCount');
            return nextColl();
          });
        });
      }, next);

    }], function() {
      stats.inserts = {};
      return sg.__runll([function(next) {

        //==========================================================================================================
        //  Instances
        //==========================================================================================================

        // Do Instances -- fetch and then store
        return jsaws.get2Instances(argv, context, function(err, instances) {
          if (err || !instances || sg.numKeys(instances) === 0) { return next(); }

          return bulkInsert('instances', instances, next);
        });

      //==========================================================================================================
      //  Images
      //==========================================================================================================

      }, function(next) {

        return jsaws.get2Images(argv, context, function(err, images) {
          if (err || !images || sg.numKeys(images) === 0) { return next(); }

          return bulkInsert('images', images, next);
        });

      //==========================================================================================================
      //  Vpcs
      //==========================================================================================================

      }, function(next) {

        return jsaws.get2Vpcs(argv, context, function(err, vpcs) {
          if (err || !vpcs || sg.numKeys(vpcs) === 0) { return next(); }

          return bulkInsert('vpcs', vpcs, next);
        });

      //==========================================================================================================
      //  ResourceRecordSets
      //==========================================================================================================

      }, function(next) {

        var params = {
          zone_name   : "mobiledevprint.net.",
          zone2_name  : "mobilewebprint.net."
        };

        return jsaws.list2ResourceRecordSets(params, context, function(err, rrs) {
          if (err || !rrs || sg.numKeys(rrs) === 0) { return next(); }

          return bulkInsert('resourceRecordSets', rrs.ResourceRecordSets, next);
        });

      //==========================================================================================================
      //  Addresses
      //==========================================================================================================

      }, function(next) {

        return jsaws.get2Addresses(argv, context, function(err, addresses) {
          if (err || !addresses || sg.numKeys(addresses) === 0) { return next(); }

          return bulkInsert('addresses', addresses, next);
        });

      }], function() {
        if (--count > 0)    { log("Again!--------"); return setTimeout(one, 20000);}

        jsMongo.close();
        return callback(null, stats);
      });
    });
  }

  function bulkInsert(collName, items_, callback) {
    var items       = _.map(items_, function(item) { return insertOne(item); });
    return colls[collName].bulkWrite(items, function(err, receipt) {
      if (err) { return callback(err); }

      log(collName, err, _.pick(receipt, 'result', 'insertedCount'));
      stats.inserts[collName] = receipt.insertedCount;

      return callback(null, receipt);
    });
  }
};

libCim.cluster = function(argv, context, callback) {

  var parts;
  var ns      = argvExtract(argv, 'namespace,ns');

  if (!ns)    { return die('ENONAMESPACE', callback, 'libCim.cluster'); }

  var result        = {};
  //var debugRelease  = result.debug = [];

  var vpcQuery = sg.dottedKv(['Tags','aws:cloudformation:stack-name'], /^mario3/);
  return toArray(dbUrl, 'vpcs', vpcQuery, function(err, vpcs) {
    if (err)      { return die(err, callback); }

    return toArray(dbUrl, 'resourceRecordSets', {Type:'A'}, function(err, rss_) {
      if (err)    { return die(err, callback); }

      var rss = _.filter(rss_, function(rs) { return rs.Name.match(/^[^.]*(pub|test|cnb|dev|ext|hq)[0-9]*[.]/i); });

      var vpcIds = _.map(vpcs, function(v) { return v.VpcId; });

      var instanceQuery = sg.dottedKv(['Tags',ns,'service'], 'web');
      instanceQuery.VpcId = {$in:vpcIds};

      return eachDoc(dbUrl, 'instances', instanceQuery, function(webInstance_, nextDoc) {
        var webInstance = _.omit(webInstance_, 'NetworkInterfaces', 'SecurityGroups', 'BlockDeviceMappings');

        setOn(webInstance, 'build',         deref(webInstance, ['Tags', ns, 'build']));
        setOn(webInstance, 'color',         deref(webInstance, ['Tags', ns, 'color']));
        setOn(webInstance, 'stack',         deref(webInstance, ['Tags', ns, 'stack']));

        return eachDoc(dbUrl, 'resourceRecordSets', {'ResourceRecords.Value':webInstance.PublicIpAddress}, function(rs, nextRs) {
          var fqdn = rs.Name.replace(/\.$/g, '');

          setOn(webInstance, 'route53Name',   fqdn);

          // Is main if has route53Name that is not a color
          if (fqdn.match(/^[a-zA-Z0-9]*-[^.]*\./)) {
            setOn(webInstance, 'next', 'next');
            setOn(webInstance, 'route', 'next');
          } else {
            setOn(webInstance, 'main', 'main');
            setOn(webInstance, 'route', 'main');
          }

          return nextRs();
        }, function() {

          setOn(result, ['instances', webInstance.InstanceId], webInstance);
          return nextDoc();
        });

      }, function() {
        return callback(null, result);
      });
    });
  });

};

_.each(libCim, function(value, key) {
  exports[key] = value;
});

function log() {
//  console.log.apply(console, arguments);
}

function insertOne(doc) {
  return {insertOne:{document:doc}};
}

function getColls(dbUrl, names, callback) {
  var colls = {};
  return sg.__eachll(names.split(','), function(name, nextName) {
    return getColl(dbUrl, name, function(err, collection) {
      if (!err && collection) {
        colls[name] = collection;
      }
      return nextName();
    });
  }, function() {
    return callback(null, colls);
  });
}

