/*
 * Copyright 2019, GeoSolutions Sas.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
*/

import * as Rx from 'rxjs';
import {LOCATION_CHANGE} from 'connected-react-router';
import {get, head, isUndefined} from 'lodash';

import {CHANGE_MAP_VIEW, CLICK_ON_MAP, INIT_MAP} from '../actions/map';
import {addMarker, hideMarker, resetSearch} from '../actions/search';
import {setControlProperty, TOGGLE_CONTROL} from '../actions/controls';

import {getLonLatFromPoint} from '../utils/CoordinatesUtils';
import {hideMapinfoMarker, purgeMapInfoResults, toggleMapInfoState} from "../actions/mapInfo";
import {clickPointSelector, isMapInfoOpen, mapInfoEnabledSelector} from '../selectors/mapInfo';
import {shareSelector} from "../selectors/controls";
import {LAYER_LOAD} from "../actions/layers";
import {changeMapType} from '../actions/maptype';
import {getCesiumViewerOptions, getParametersValues, getQueryActions, paramActions} from "../utils/QueryParamsUtils";
import {semaphore} from "../utils/EpicsUtils";

/**
 * Intercept on `LOCATION_CHANGE` to get query params from router.location.search string.
 * - It waits for the first `LAYER_LOAD` to ensure that width and height of map are in the state as well as the final bbox bounds data.
 * - If specific map viewer options are found (atm just cesium) fire an action to change map type to the appropriate one
 * - Orientates map if cesium viewer is active and query parameters contains necessary value
 * @param {external:Observable} action$ manages `LOCATION_CHANGE` and `LAYER_LOAD`
 * @memberof epics.queryparams
 * @return {external:Observable}
 */
export const readQueryParamsOnMapEpic = (action$, store) => {
    let skipProcessing = false;
    return action$.ofType(LOCATION_CHANGE)
        // this stop / start listening for one LOCATION_CHANGE event if `skipProcessing` is true, useful when this action is triggered by switching map-type
        .let(semaphore(
            action$.ofType(LOCATION_CHANGE)
                .map(() => !skipProcessing)
                .startWith(true)
                .do(() => {skipProcessing = false;})
        ))
        .switchMap(() => {
            const parameters = getParametersValues(paramActions, store.getState());
            return Rx.Observable.merge(
                action$.ofType(INIT_MAP)
                    .take(1)
                    .switchMap(() => {
                        // On map initialization, query params containing cesium viewer options
                        // is used to determine cesium map type
                        const cesiumViewerOptions = getCesiumViewerOptions(parameters);
                        if (cesiumViewerOptions) {
                            skipProcessing = true;
                            return Rx.Observable.of(changeMapType('cesium'));
                        }
                        return Rx.Observable.empty();
                    }),
                action$.ofType(LAYER_LOAD)
                    .take(1)
                    .switchMap(() => {
                        const queryActions = getQueryActions(parameters, paramActions, store.getState());
                        return head(queryActions)
                            ? Rx.Observable.of(...queryActions)
                            : Rx.Observable.empty();
                    }),
                action$.ofType(CHANGE_MAP_VIEW)
                    .take(1)
                    .switchMap(() => {
                        const mapType = get(store.getState(), 'maptype.mapType') || '';
                        if (mapType === 'cesium') {
                            const queryActions = getQueryActions(parameters, paramActions, store.getState());
                            return head(queryActions)
                                ? Rx.Observable.of(...queryActions)
                                : Rx.Observable.empty();
                        }
                        return Rx.Observable.empty();
                    })
            );
        });
};

/**
 * Intercept on `CLICK_ON_MAP` to get point and layer information to allow featureInfoClick.
 * @param {external:Observable} action$ manages `CLICK_ON_MAP`
 * @param getState
 * @memberof epics.share
 * @return {external:Observable}
 */
export const onMapClickForShareEpic = (action$, { getState = () => { } }) =>
    action$.ofType(CLICK_ON_MAP).
        switchMap(({point}) =>{
            const allowClick = get(getState(), 'controls.share.settings.centerAndZoomEnabled');
            return allowClick
                ? Rx.Observable.of(resetSearch(), addMarker({latlng: point?.latlng || {}}))
                : Rx.Observable.empty();
        });

/**
 * Intercept on `TOGGLE_CONTROL` to perform toggleMapInfoState and clean up on share panel close.
 * @param {external:Observable} action$ manages `TOGGLE_CONTROL`
 * @param getState
 * @memberof epics.share
 * @return {external:Observable}
 */
export const disableGFIForShareEpic = (action$, { getState = () => { } }) =>
    action$.ofType(TOGGLE_CONTROL)
        .filter(({control}) => control === "share")
        .switchMap(() => {
            const state = getState();
            const shareEnabled = shareSelector(state);
            const mapInfoEnabled = mapInfoEnabledSelector(state);
            const shareParams = {bboxEnabled: false, centerAndZoomEnabled: false};
            if (!isUndefined(shareEnabled) && shareEnabled) {
                let $observable = Rx.Observable.empty();
                if (mapInfoEnabled) {
                    let actions = [toggleMapInfoState()];
                    if (isMapInfoOpen(state)) {
                        const clickedPoint = clickPointSelector(state);
                        const [lng, lat] = getLonLatFromPoint(clickedPoint);
                        const newPoint = {latlng: {lat, lng}};
                        actions = actions.concat(addMarker(newPoint)); // Retain marker position set by GFI for Share position marker
                    }
                    $observable = Rx.Observable.from(actions);
                }
                return $observable;
            }
            return Rx.Observable.of(hideMapinfoMarker(),
                purgeMapInfoResults(),
                toggleMapInfoState(),
                setControlProperty("share", "settings", shareParams),
                hideMarker()
            );
        });

export default {
    readQueryParamsOnMapEpic,
    onMapClickForShareEpic,
    disableGFIForShareEpic
};
