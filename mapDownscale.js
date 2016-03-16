#!/usr/bin/env node
'use strict';

var mbtiles = require('tile-reduce/src/mbtiles.js'); // todo: hacky?
var MBTiles = require('mbtiles');
var queue = require('queue-async');
var binarysplit = require('binary-split');
var turf = require('turf');
var sphericalmercator = new (require('sphericalmercator'))();

var binningFactor = global.mapOptions.binningFactor; // number of slices in each direction
var mbtilesPath = global.mapOptions.mbtilesPath;

var initQueue = queue(1);

initQueue.defer(mbtiles, {
    name: 'osm',
    mbtiles: mbtilesPath,
    raw: false
});
initQueue.defer(function(cb) {
    var db = new MBTiles(mbtilesPath, function(err) {
        if (err) cb(err);
        var tilesArray = [];
        var tileStream = db.createZXYStream()
            .pipe(binarysplit('\n'))
            .on('data', function(line) {
                var tile = line.toString().split('/');
                tilesArray.push([+tile[1], +tile[2], +tile[0]]);
             })
            .on('end', function() {
                cb(null, tilesArray);
            });
    });
});

var todoList = {},
    getVT,
    initalizationDone = false;

module.exports = function _(tileLayers, tile, writeData, done) {
    if (!initalizationDone) {
        // wait until initializations are completed
        initQueue.await(function(err, _getVT, tilesArray) {
            if (err) throw err;

            getVT = _getVT;
            // calculate list of 2x2 tiles to process while downscaling
            var originalZoom = tilesArray[0][2];
            tilesArray.forEach(function(tile) {
                var metaX = Math.floor(tile[0] / 2),
                    metaY = Math.floor(tile[1] / 2);
                var todoListIndex = metaX+'/'+metaY;
                todoList[todoListIndex] = [tile[0], tile[1]];
            });
            // re-start current tile-reduce job after initializations are complete
            initalizationDone = true;
            _(tileLayers, tile, writeData, done);
        });
        return;
    }

    var metaX = Math.floor(tile[0] / 2),
        metaY = Math.floor(tile[1] / 2);
    var todoListIndex = metaX+'/'+metaY;

    if (todoList[todoListIndex][0] === tile[0] && todoList[todoListIndex][1] === tile[1]) {
        processMeta(getVT, [metaX, metaY, tile[2]-1], done);
    } else {
        done(); // ignore additional tiles in 2x2 meta tile
    }

}

function processMeta(getVT, tile, done) {
    var q = queue();
    // load all (zoom+1) VTs in this tile
    q.defer(getVT, [tile[0]*2  , tile[1]*2+1, tile[2]+1]);
    q.defer(getVT, [tile[0]*2+1, tile[1]*2+1, tile[2]+1]);
    q.defer(getVT, [tile[0]*2  , tile[1]*2  , tile[2]+1]);
    q.defer(getVT, [tile[0]*2+1, tile[1]*2  , tile[2]+1]);
    q.awaitAll(function(err, data) {
        if (err) throw err;
        // load all bins into 2d array
        var bins = Array(2*binningFactor);
        var refArea = turf.area(turf.bboxPolygon(sphericalmercator.bbox(tile[0],tile[1],tile[2])))/Math.pow(binningFactor,2)/4;
        data.forEach(function(tile, index) {
            if (!tile) return;
            tile = tile.osm;
            tile.features.forEach(function(feature) {
                var binArea = turf.area(feature);
                if (binArea < refArea/3) return; // ignore degenerate slices

                var binX = feature.properties.binX + (index % 2)*binningFactor,
                    binY = feature.properties.binY + Math.floor(index / 2)*binningFactor;
                if (!bins[binX]) bins[binX] = Array(2*binningFactor);
                bins[binX][binY] = feature;
            });
        });
        // aggregate data
        var output = turf.featurecollection([]);
        output.properties = { tileX: tile[0], tileY: tile[1], tileZ: tile[2] }; // todo: drop eventually
        var tileBbox = sphericalmercator.bbox(tile[0],tile[1],tile[2]),
            bboxHeight = tileBbox[3]-tileBbox[1],
            bboxWidth  = tileBbox[2]-tileBbox[0];
        for (var i=0; i<binningFactor; i++) {
            for (var j=0; j<binningFactor; j++) {
                var bin = turf.bboxPolygon([
                    tileBbox[0] + bboxWidth /binningFactor*j,
                    tileBbox[1] + bboxHeight/binningFactor*i,
                    tileBbox[0] + bboxWidth /binningFactor*(j+1),
                    tileBbox[1] + bboxHeight/binningFactor*(i+1),
                ]);
                var _bins = [
                    bins[j*2  ] && bins[j*2  ][i*2  ],
                    bins[j*2+1] && bins[j*2+1][i*2  ],
                    bins[j*2  ] && bins[j*2  ][i*2+1],
                    bins[j*2+1] && bins[j*2+1][i*2+1]
                ].filter(function(b) { return b; });
                bin.properties.binX = j;
                bin.properties.binY = i;
                bin.properties.count = _bins.reduce(function(prev, _bin) { return prev + _bin.properties.count }, 0);
                output.features.push(bin);
            }
        }
        output.features = output.features.filter(function(feature) {
            return feature.properties.count > 0;
        });
        // write to stdout
        writeData(JSON.stringify(output)+'\n');
        done();
    });
}