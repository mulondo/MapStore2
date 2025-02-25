/**
 * Copyright 2022, GeoSolutions Sas.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Layers from '../../../../utils/cesium/Layers';
import * as Cesium from 'cesium';
import isEqual from 'lodash/isEqual';
import isNumber from 'lodash/isNumber';
import isNaN from 'lodash/isNaN';
import { getProxyUrl, needProxy } from "../../../../utils/ProxyUtils";
import { getStyleParser } from '../../../../utils/VectorStyleUtils';
import { polygonToClippingPlanes } from '../../../../utils/cesium/PrimitivesUtils';

function getStyle({ style }) {
    const { format, body } = style || {};
    if (!format || !body) {
        return Promise.resolve(null);
    }
    if (format === '3dtiles') {
        return Promise.resolve(body);
    }
    if (format === 'geostyler') {
        return getStyleParser('3dtiles')
            .then((parser) => parser.writeStyle(body));
    }
    return Promise.all([
        getStyleParser(format),
        getStyleParser('3dtiles')
    ])
        .then(([parser, threeDTilesParser]) =>
            parser
                .readStyle(body)
                .then(parsedStyle => threeDTilesParser.writeStyle(parsedStyle))
        );
}

function updateModelMatrix(tileSet, { heightOffset }) {
    if (!isNaN(heightOffset) && isNumber(heightOffset)) {
        const boundingSphere = tileSet.boundingSphere;
        const cartographic = Cesium.Cartographic.fromCartesian(boundingSphere.center);
        const surface = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0.0);
        const offset = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, heightOffset);
        const translation = Cesium.Cartesian3.subtract(offset, surface, new Cesium.Cartesian3());
        tileSet.modelMatrix =  Cesium.Matrix4.fromTranslation(translation);
    }
}

function clip3DTiles(tileSet, options, map) {
    if (options.clippingPolygon) {
        polygonToClippingPlanes(options.clippingPolygon, !!options.clippingPolygonUnion, options.clipOriginalGeometry)
            .then((planes) => {
                tileSet.clippingPlanes = new Cesium.ClippingPlaneCollection({
                    modelMatrix: Cesium.Matrix4.inverse(
                        Cesium.Matrix4.multiply(
                            tileSet.root.computedTransform,
                            tileSet._initialClippingPlanesOriginMatrix,
                            new Cesium.Matrix4()
                        ),
                        new Cesium.Matrix4()),
                    planes,
                    edgeWidth: 1.0,
                    edgeColor: Cesium.Color.WHITE,
                    unionClippingRegions: !!options.clippingPolygonUnion
                });
                map.scene.requestRender();
            });
    } else {
        tileSet.clippingPlanes = new Cesium.ClippingPlaneCollection({ planes: [] });
        map.scene.requestRender();
    }
}

function ensureReady(tileSet, callback) {
    if (tileSet.ready) {
        callback();
    } else {
        tileSet.readyPromise.then(() => {
            callback();
        });
    }
}

Layers.registerType('3dtiles', {
    create: (options, map) => {
        if (options.visibility && options.url) {

            const tileSet = map.scene.primitives.add(new Cesium.Cesium3DTileset({
                url: new Cesium.Resource({
                    url: options.url,
                    proxy: needProxy(options.url) ? new Cesium.DefaultProxy(getProxyUrl()) : undefined
                    // TODO: axios supports also adding access tokens or credentials (e.g. authkey, Authentication header ...).
                    // if we want to use internal cesium functionality to retrieve data
                    // we need to create a utility to set a CesiumResource that applies also this part.
                    // in addition to this proxy.
                })
            }));

            // assign the original mapstore id of the layer
            tileSet.msId = options.id;

            ensureReady(tileSet, () => {
                updateModelMatrix(tileSet, options);
                clip3DTiles(tileSet, options, map);
                getStyle(options)
                    .then((style) => {
                        if (style) {
                            tileSet.style = new Cesium.Cesium3DTileStyle(style);
                        }
                    });
            });

            return {
                detached: true,
                tileSet,
                remove: () => {
                    map.scene.primitives.remove(tileSet);
                },
                setVisible: (visible) => {
                    tileSet.show = !!visible;
                }
            };
        }
        return {
            detached: true,
            remove: () => {},
            setVisible: () => {}
        };
    },
    update: function(layer, newOptions, oldOptions, map) {
        if (newOptions.visibility && !oldOptions.visibility) {
            return this.create(newOptions, map);
        }
        if (!newOptions.visibility && oldOptions.visibility && layer?.remove) {
            layer.remove();
            return null;
        }
        if (
            (!isEqual(newOptions.clippingPolygon, oldOptions.clippingPolygon)
            || newOptions.clippingPolygonUnion !== oldOptions.clippingPolygonUnion
            || newOptions.clipOriginalGeometry !== oldOptions.clipOriginalGeometry)
         && layer?.tileSet) {
            ensureReady(layer.tileSet, () => {
                clip3DTiles(layer.tileSet, newOptions, map);
            });
        }
        if (!isEqual(newOptions.style, oldOptions.style) && layer?.tileSet) {
            ensureReady(layer.tileSet, () => {
                getStyle(newOptions)
                    .then((style) => {
                        if (style && layer?.tileSet) {
                            layer.tileSet.makeStyleDirty();
                            layer.tileSet.style = new Cesium.Cesium3DTileStyle(style);
                        }
                    });
            });
        }
        if (layer?.tileSet && newOptions.heightOffset !== oldOptions.heightOffset) {
            ensureReady(layer.tileSet, () => {
                updateModelMatrix(layer.tileSet, newOptions);
            });
        }
        return null;
    }
});
