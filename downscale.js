#!/usr/bin/env node
'use strict';
var tileReduce = require('tile-reduce');
var path = require('path');

var mbtilesPath = process.argv[2] || "osm.mbtiles";
var binningFactor = +process.argv[3] || 100;

var cpus = require('os').cpus().length;

tileReduce({
    map: path.join(__dirname, '/mapDownscale.js'),
    sources: [{
        name: 'osm',
        mbtiles: mbtilesPath,
        raw: true
    }],
    mapOptions: {
        mbtilesPath: mbtilesPath,
        binningFactor: binningFactor
    },
    maxWorkers: Math.max(1, Math.floor(cpus/4)*4 - 1) // make sure the number of threads is not divisible by 4 to make sure that there's no congestion of tiles at a particular worker
})
.on('reduce', function(d) {
})
.on('end', function() {
});
