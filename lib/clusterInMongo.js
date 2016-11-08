
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
var deref               = sg.deref;
var getColl             = jsMongo.collection;

var dbHost              = '10.11.21.220';
var dbName              = 'aws_cluster';
var dbUrl               = 'mongodb://'+dbHost+':27017/'+dbName;

var collNames           = ['images', 'instances', 'vpcs', 'resourceRecordSets', 'addresses'];

var libCim = {};

var dict  = {};
var stats = {deleted:0};

var clusterInMongo = libCim.clusterInMongo = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);
  var awsSns        = jsaws.getSns(argv);
  var awsIam        = jsaws.getIam(argv);
  var region        = argvExtract(argv, 'region');
  var awsRoute53    = jsaws.getRoute53(argv);

  var count         = argvExtract(argv, 'count');

  var colls         = {};

  one();
  function one() {

    return sg.__run([function(next) {
      // Remove all data
      return sg.__eachll(collNames, function(collName, nextColl) {
        return getColl(dbUrl, collName, function(err, collection) {

          colls[collName] = collection;

          return collection.deleteMany({}, function(err, receipt) {
            console.log('deleteMany: '+collName, err, _.pick(receipt, 'result', 'deletedCount'));
            stats.deleted  += deref(receipt, 'deletedCount');
            return nextColl();
          });
        });
      }, next);

    }], function() {
      stats.inserts = {};
      return sg.__run([function(next) {

        //==========================================================================================================
        //  Instances
        //==========================================================================================================

        // Do Instances -- fetch and then store
        return jsaws.getInstances(argv, context, function(err, instances) {
          if (err || !instances || sg.numKeys(instances) === 0) { return next(); }

          return bulkInsert('instances', instances, function(err, receipt) {
            //console.log('instances', err, _.pick(receipt, 'result', 'insertedCount'));
            stats.inserts.instances = receipt.insertedCount;
            return next();
          });
        });

      }, function(next) {

        return jsaws.getImages(argv, context, function(err, images) {
          if (err || !images || sg.numKeys(images) === 0) { return next(); }

          return bulkInsert('images', images, function(err, receipt) {
            //console.log('images', err, _.pick(receipt, 'result', 'insertedCount'));
            stats.inserts.images = receipt.insertedCount;
            return next();
          });
        });

      }, function(next) {

        return jsaws.getVpcs(argv, context, function(err, vpcs) {
          if (err || !vpcs || sg.numKeys(vpcs) === 0) { return next(); }

          return bulkInsert('vpcs', vpcs, function(err, receipt) {
            //console.log('vpcs', err, _.pick(receipt, 'result', 'insertedCount'));
            stats.inserts.vpcs = receipt.insertedCount;
            return next();
          });
        });

      }, function(next) {

        var params = {
          zone_name   : "mobiledevprint.net."
        };

        return jsaws.listResourceRecordSets(params, context, function(err, rrs) {
          if (err || !rrs || sg.numKeys(rrs) === 0) { return next(); }

          return bulkInsert('resourceRecordSets', rrs.ResourceRecordSets, function(err, receipt) {
            //console.log('resourceRecordSets', err, _.pick(receipt, 'result', 'insertedCount'));
            stats.inserts.resourceRecordSets = receipt.insertedCount;
            return next();
          });
        });

      }, function(next) {

        return awsEc2.describeAddresses({}, function(err, addresses) {
          if (err || !addresses || sg.numKeys(addresses) === 0) { return next(); }

          return bulkInsert('addresses', addresses.Addresses, function(err, receipt) {
            //console.log('addresses', err, _.pick(receipt, 'result', 'insertedCount'));
            stats.inserts.addresses = receipt.insertedCount;
            return next();
          });
        });

      }], function() {
        if (--count > 0)    { console.log("Again!--------"); return setTimeout(one, 20000);}

        jsMongo.close();
        return callback(null, stats);
      });
    });
  }

  function bulkInsert(collName, items_, callback) {
    var items       = _.map(items_, function(item) { return insertOne(item); });
    return colls[collName].bulkWrite(items, function(err, r) {
      if (err) { return callback(err); }

      return callback(null, r);
    });
  }
};

_.each(libCim, function(value, key) {
  exports[key] = value;
});

//clusterInMongo({}, {}, function(){});

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

