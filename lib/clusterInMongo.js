
/**
 *  Read info from various AWS APIs and put the info into MongoDB.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var jsMongo             = require('js-mongo');
var jsaws               = require('./jsaws');

var argvGet             = sg.argvGet;
var getColl             = jsMongo.collection;

var dbHost              = '10.10.21.220';
var dbName              = 'aws_cluster';
var dbUrl               = 'mongodb://'+dbHost+':27017/'+dbName;

var collNames           = ['eips', 'nicEips', 'orphanEips', 'allEips'];

var libCim = {};

var dict  = {};

var clusterInMongo = libCim.clusterInMongo = function(argv, context, callback) {
  argv              = jsaws.prep(argv);
  var awsEc2        = jsaws.getEc2(argv);
  var awsSns        = jsaws.getSns(argv);
  var awsIam        = jsaws.getIam(argv);
  var awsRoute53    = jsaws.getRoute53(argv);

  var count         = argvGet(argv, 'count');

  one();
  function one() {

    return sg.__run([function(next) {
      // Remove all data
      return sg.__eachll(collNames, function(collName, nextColl) {
        return getColl(dbUrl, collName, function(err, collection) {
          return collection.deleteMany({}, function(err, receipt) {
//            console.log('deleteMany: '+collName, err, _.pick(receipt, 'result', 'deletedCount'));
            return nextColl();
          });
        });
      }, next);

    }], function() {
      return sg.__runll([function(next) {
        // Do EIPs -- fetch and then store
        var eips = [], nicEips = [], orphanEips = [], allEips = [];
        return awsEc2.describeAddresses({}, function(err, addresses) {
          _.each(addresses.Addresses, function(address) {
            if ('InstanceId' in address)            { eips.push(insertOne(address));        setOnMulti(dict, 'eips', address, 'PublicIp,AllocationId,InstanceId'); }
            else if ('AssociationId' in address)    { nicEips.push(insertOne(address));     setOnMulti(dict, 'nicEips', address, 'PublicIp,AllocationId'); }
            else                                    { orphanEips.push(insertOne(address));  setOnMulti(dict, 'orphanEips', address, 'PublicIp,AllocationId'); }

            allEips.push(insertOne(address));
            setOnMulti(dict, 'allEips', address, 'PublicIp,AllocationId');
          });

//          console.log('eips', eips.length);
//          console.log('nicEips', nicEips.length);
//          console.log('orphanEips', orphanEips.length);
//          console.log('allEips', allEips.length);

          // Now bulk-insert them
          var colls = {};
          return sg.__eachll('eips,nicEips,orphanEips,allEips'.split(','), function(name, nextName) {
            return getColl(dbUrl, name, function(err, collection) {
              if (!err) {
                colls[name] = collection;
              }
              return nextName();
            });
          }, function() {
            return sg.__runll([function(next)   { colls.eips.bulkWrite(eips, function(err, r)               { return next(); }); },
              function(next)                    { colls.nicEips.bulkWrite(nicEips, function(err, r)         { return next(); }); },
              function(next)                    { colls.orphanEips.bulkWrite(orphanEips, function(err, r)   { return next(); }); },
              function(next)                    { colls.allEips.bulkWrite(allEips, function(err, r)         { return next(); }); }
            ], next);
          });
        });
      }, function(next) {
        // Do Instances -- fetch and then store
        var instances, colls;
        return sg.__runll([function(next) {
          return jsaws.getInstances(argv, context, function(err, instances_) {
            if (!err) { instances = instances_; }
            return next();
          });
        }, function(next) {
          return getColls(dbUrl, names, function(err, colls_) {
            if (!err) { colls = colls_; }
            return next();
          });
        }], function() {
        });

        return next();
      }], function() {
        if (--count > 0)    { return setTimeout(one, 20000);}

        jsMongo.close();
        return callback();
      });
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

/**
 *  Calls setOn many times
 */
function setOnMulti(obj, keyStart, value, attrNames) {
  _.each(attrNames.split(','), function(name) {
    sg.setOn(obj, [keyStart, name].join('.'), value);
  });
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

