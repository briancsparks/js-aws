
/**
 *  Read info from various AWS APIs and put the info into MongoDB.
 */

var sg                  = require('sgsg');
var _                   = sg._;
var jsMongo             = require('js-mongo');
var jsaws               = require('./jsaws');

//var coldMeds            = sg.??
var argvGet             = sg.argvGet;
var argvExtract         = sg.argvExtract;
var setOnMulti          = sg.setOnMulti;
var deref               = sg.deref;
var getColl             = jsMongo.collection;

var dbHost              = '10.10.21.220';
var dbName              = 'aws_cluster';
var dbUrl               = 'mongodb://'+dbHost+':27017/'+dbName;

var collNames           = ['eips', 'nicEips', 'orphanEips', 'allEips', 'images', 'instances', 'vpcs', 'resourceRecordSets'];

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
      return sg.__runll([function(next) {

        //==========================================================================================================
        //  EIPs
        //==========================================================================================================

        // Do EIPs -- fetch and then store
        var eips = [], nicEips = [], orphanEips = [], allEips = [];
        return awsEc2.describeAddresses({}, function(err, addresses) {
          stats.eipCount      = addresses.length;
          stats.instanceEips  = 0;
          stats.nicEips       = 0;
          stats.orphanEips    = 0;

          _.each(addresses.Addresses, function(address) {
            if ('InstanceId' in address)            { stats.instanceEips++; eips.push(insertOne(address));        setOnMulti(dict, 'eips', address, 'PublicIp,AllocationId,InstanceId'); }
            else if ('AssociationId' in address)    { stats.nicEips++;      nicEips.push(insertOne(address));     setOnMulti(dict, 'nicEips', address, 'PublicIp,AllocationId'); }
            else                                    { stats.orphanEips++;   orphanEips.push(insertOne(address));  setOnMulti(dict, 'orphanEips', address, 'PublicIp,AllocationId'); }

            allEips.push(insertOne(address));
            setOnMulti(dict, 'allEips', address, 'PublicIp,AllocationId');
          });

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

      //==========================================================================================================
      //  Instances
      //==========================================================================================================

      }, function(next) {
        // Do Instances -- fetch and then store
        return jsaws.getInstances(argv, context, function(err, instances_) {
          if (err || !instances_ || sg.numKeys(instances_) === 0) { return next(); }

          var instances       = _.map(instances_, function(instance) { return insertOne(instance); });
          stats.numInstances  = instances.length;
          return colls.instances.bulkWrite(instances, function(err, r) {
            return next();
          });
        });

      //==========================================================================================================
      //  Images
      //==========================================================================================================

      }, function(next) {
        // Do Images -- fetch and then store
        return jsaws.getImages(argv, context, function(err, images_) {
          if (err || !images_ || sg.numKeys(images_) === 0) { return next(); }

          var images          = _.map(images_, function(image) { return insertOne(image); });
          stats.numImages     = images.length;
          return colls.images.bulkWrite(images, function(err, r) {
            return next();
          });
        });

      //==========================================================================================================
      //  VPCs
      //==========================================================================================================

      }, function(next) {
        // Do VPCs -- fetch and then store
        return jsaws.getVpcs(argv, context, function(err, vpcs_) {
          if (err || !vpcs_ || sg.numKeys(vpcs_) === 0) { return next(); }

          var vpcs            = _.map(vpcs_, function(vpc) { return insertOne(vpc); });
          stats.numVpcs       = vpcs.length;
          return colls.vpcs.bulkWrite(vpcs, function(err, r) {
            return next();
          });
        });

      //==========================================================================================================
      //  Resource Record Sets
      //==========================================================================================================

      }, function(next) {
        // Do RRs -- fetch and then store
        var params = {
          zone_name   : "mobiledevprint.net."
        };

        return jsaws.listResourceRecordSets(params, context, function(err, rrs_) {
          if (err || !rrs_ || sg.numKeys(rrs_) === 0) { return next(); }

          var rrs = _.map(rrs_.ResourceRecordSets, function(rr) { return insertOne(rr); });
          stats.numRRs  = rrs.length;
          return colls.resourceRecordSets.bulkWrite(rrs, function(err, r) {
            return next();
          });
        });

      }], function() {
        if (--count > 0)    { return setTimeout(one, 20000);}

        jsMongo.close();
        return callback(null, stats);
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

