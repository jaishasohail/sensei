import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  FlatList, ActivityIndicator, Dimensions, ScrollView,
  Animated, Alert, StatusBar,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useRoute, useNavigation } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import GoogleMapsService      from '../services/GoogleMapsService';
import LocationService        from '../services/LocationService';
import TextToSpeechService    from '../services/TextToSpeechService';
import VoiceCommandService    from '../services/VoiceCommandService';
import IndoorNavigationService from '../services/IndoorNavigationService';
import PinnedLocationService  from '../services/PinnedLocationService';
import RouteMemoryService     from '../services/RouteMemoryService';
import OfflineModeService     from '../services/OfflineModeService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS, SHADOWS } from '../constants/theme';

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
const MAP_HEIGHT = Math.round(SCREEN_HEIGHT * 0.44);

// ── Google-encoded polyline decoder ───────────────────────────────────────────
function decodePolyline(encoded) {
  const pts = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; }
    while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; }
    while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    pts.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return pts;
}

// ── Maneuver → icon name ───────────────────────────────────────────────────────
function maneuverIcon(maneuver = '') {
  if (maneuver.includes('left'))       return 'arrow-back-circle';
  if (maneuver.includes('right'))      return 'arrow-forward-circle';
  if (maneuver.includes('uturn'))      return 'return-down-back';
  if (maneuver.includes('roundabout')) return 'refresh-circle';
  if (maneuver.includes('merge'))      return 'git-merge';
  if (maneuver.includes('dest'))       return 'location';
  return 'arrow-up-circle';
}

// ── Maneuver → accent colour ───────────────────────────────────────────────────
function maneuverColor(maneuver = '') {
  if (maneuver.includes('left') || maneuver.includes('right')) return COLORS.warning;
  if (maneuver.includes('dest'))                               return COLORS.success;
  return COLORS.primary;
}

// ── Format metres to human string ─────────────────────────────────────────────
function fmtDist(m) {
  if (m == null) return '--';
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

// ── Format minutes to human string ───────────────────────────────────────────
function fmtTime(min) {
  if (min == null) return '--';
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.round(min)} min`;
}

// ─────────────────────────────────────────────────────────────────────────────
export default function NavigationScreen() {
  const route      = useRoute();
  const navigation = useNavigation();
  const mapRef     = useRef(null);
  const lastParamRef = useRef(null);
  const resultsFade = useRef(new Animated.Value(0)).current;
  // Keeps a pointer to the latest triggerSearch so the VoiceCommandService
  // direct callback can call it without stale-closure issues.
  const triggerSearchRef = useRef(null);

  // ── State ──────────────────────────────────────────────────────────────────
  const [searchQuery,     setSearchQuery]     = useState('');
  const [searchResults,   setSearchResults]   = useState([]);
  const [isSearching,     setIsSearching]     = useState(false);
  const [isNavigating,    setIsNavigating]    = useState(false);
  const [navData,         setNavData]         = useState(null);
  const [selectedDest,    setSelectedDest]    = useState(null);
  const [routeCoords,     setRouteCoords]     = useState([]);
  const [currentLoc,      setCurrentLoc]      = useState(null);
  const [savedRoutes,     setSavedRoutes]     = useState([]);
  const [recentSearches,  setRecentSearches]  = useState([]);
  const [offlineRoutes,   setOfflineRoutes]   = useState([]);
  const [isOnline,        setIsOnline]        = useState(true);

  // ── Indoor navigation state ────────────────────────────────────────────────
  const [isIndoorMode,      setIsIndoorMode]      = useState(false);
  const [indoorSteps,       setIndoorSteps]       = useState([]);
  const [indoorStepIndex,   setIndoorStepIndex]   = useState(0);
  const [indoorBuilding,    setIndoorBuilding]    = useState(null);
  // Pinned locations panel
  const [pinnedLocations,   setPinnedLocations]   = useState([]);

  // ── Load persistent data ──────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      await RouteMemoryService.initialize();
      setSavedRoutes(RouteMemoryService.getSavedRoutes().slice(0, 5));
      setRecentSearches(RouteMemoryService.getRecentSearches(6));
      const offline = await OfflineModeService.listOfflineRoutes();
      setOfflineRoutes(offline);
      const online = await OfflineModeService.isOnline();
      setIsOnline(online);
    } catch (e) {
      console.error('NavigationScreen loadData error:', e);
    }
  }, []);

  // ── Init ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const loc = await LocationService.getFreshLocation().catch(() =>
          LocationService.getCurrentLocation()
        );
        setCurrentLoc(loc);
        // Auto-detect nearby building
        await IndoorNavigationService.initialize();
        const nearby = await IndoorNavigationService.detectNearbyBuilding(loc.latitude, loc.longitude, 80);
        if (nearby) {
          setIndoorBuilding(nearby.building);
          await IndoorNavigationService.setActiveBuilding(nearby.building.id);
        }
      } catch (_) {}
      await loadData();
      // Load pinned locations for the quick-access panel
      await PinnedLocationService.initialize();
      const pins = await PinnedLocationService.getAllPins();
      setPinnedLocations(pins.slice(0, 8));
    })();

    // Keep map marker in sync with real movement (fixes stale coords after user moves)
    LocationService.startWatchingLocation((loc) => {
      setCurrentLoc(loc);
    }).catch(() => {});

    return () => {
      GoogleMapsService.stopNavigation();
      LocationService.stopWatchingLocation();
    };
  }, [loadData]);

  // ── React to voice-command params ─────────────────────────────────────────
  // Using useEffect (not useFocusEffect) so this fires whenever route.params
  // changes — even when the Navigation tab is already the active screen.
  // useFocusEffect only fires on focus events, so it was silently skipped
  // when the user said a voice command while already on this screen.
  useEffect(() => {
    const params = route.params;
    const paramKey = params?.destination;
    if (paramKey && paramKey !== lastParamRef.current) {
      lastParamRef.current = paramKey;
      setSearchQuery(paramKey);
      // Capture autoNavigate before clearing params so we don't lose it
      const autoNav = params.autoNavigate === true;
      triggerSearch(paramKey, autoNav);
      // Clear params so navigating away and back doesn't re-trigger the search
      navigation.setParams({ destination: undefined, autoNavigate: undefined });
    }
  }, [route.params]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fit map when route changes ─────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current && routeCoords.length > 1) {
      mapRef.current.fitToCoordinates(routeCoords, {
        edgePadding: { top: 80, right: 50, bottom: 80, left: 50 },
        animated: true,
      });
    }
  }, [routeCoords]);

  // ── Animate search results in ──────────────────────────────────────────────
  useEffect(() => {
    Animated.timing(resultsFade, {
      toValue: searchResults.length > 0 ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [searchResults.length, resultsFade]);

  // ── Search ─────────────────────────────────────────────────────────────────
  // extras.pinnedDest — skip geocoding; navigate directly to stored coords
  const triggerSearch = async (query, autoNavigate, extras = {}) => {
    if (!query?.trim()) return;

    // ── Pinned location shortcut: bypass geocoder ─────────────────────────
    if (extras?.pinnedDest) {
      const { name, latitude, longitude, address } = extras.pinnedDest;
      if (latitude != null && longitude != null) {
        await selectAndNavigate({
          name,
          latitude,
          longitude,
          formatted_address: address ?? name,
          geometry: { location: { lat: latitude, lng: longitude } },
        });
        return;
      }
    }

    setIsSearching(true);
    setSearchResults([]);
    try {
      const loc = currentLoc || (await LocationService.getCurrentLocation());
      const results = await GoogleMapsService.searchPlace(query, loc);
      if (results?.length > 0) {
        if (autoNavigate) {
          await selectAndNavigate(results[0]);
        } else {
          setSearchResults(results);
        }
      } else {
        await TextToSpeechService.speak(
          `Could not find ${query}. Try a more specific address.`,
        );
      }
    } catch (err) {
      console.error('NavigationScreen search error:', err);
      await TextToSpeechService.speak('Search failed. Check your connection.');
    } finally {
      setIsSearching(false);
    }
  };
  // Keep the ref in sync on every render so the VoiceCommandService callback
  // always calls the most up-to-date version (with fresh state closures).
  triggerSearchRef.current = triggerSearch;

  // ── Register direct voice-command callback ─────────────────────────────────
  useEffect(() => {
    // Callback receives (dest, autoNav, extras)
    // extras.pinnedDest  → { name, latitude, longitude } — skip geocoding
    // extras.indoorSteps → Step[] — start indoor navigation immediately
    VoiceCommandService.setNavCallback((dest, autoNav, extras) => {
      if (!dest) return;

      // ── Indoor navigation ───────────────────────────────────────────────
      if (extras?.indoorSteps?.length > 0) {
        setIsIndoorMode(true);
        setIndoorSteps(extras.indoorSteps);
        setIndoorStepIndex(0);
        setIsNavigating(true);
        setSelectedDest(extras.indoorDest ? {
          name: extras.indoorDest.name ?? dest,
          latitude: extras.indoorDest.latitude ?? null,
          longitude: extras.indoorDest.longitude ?? null,
        } : { name: dest });
        setSearchQuery(dest.replace('[INDOOR] ', ''));
        return;
      }

      // ── Pinned location — navigate directly without geocoding ───────────
      if (extras?.pinnedDest) {
        const { name, latitude, longitude, address } = extras.pinnedDest;
        setSearchQuery(name);
        triggerSearchRef.current?.(name, true, { pinnedDest: extras.pinnedDest });
        return;
      }

      // ── Normal geocode search ───────────────────────────────────────────
      setSearchQuery(dest);
      triggerSearchRef.current?.(dest, autoNav === true);
    });
    return () => { VoiceCommandService.setNavCallback(null); };
  }, []); // only on mount / unmount — callback uses ref, never goes stale

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
  };

  // ── Select a result and begin navigation ───────────────────────────────────
  const selectAndNavigate = async (place) => {
    const dest = {
      name:      place.name || place.formatted_address || 'Destination',
      latitude:  place.geometry?.location?.lat ?? place.latitude,
      longitude: place.geometry?.location?.lng ?? place.longitude,
      address:   place.formatted_address || place.vicinity || '',
    };
    setSelectedDest(dest);
    setSearchResults([]);
    // Record as a recent search immediately (before network latency)
    RouteMemoryService.addRecentSearch(dest);
    await startNavigation(dest);
  };

  // ── Start turn-by-turn ─────────────────────────────────────────────────────
  const startNavigation = async (dest) => {
    try {
      await TextToSpeechService.speak(`Starting navigation to ${dest.name}`);
      const origin = await LocationService.getFreshLocation().catch(() =>
        LocationService.getCurrentLocation()
      );
      if (origin) setCurrentLoc(origin);

      const routeData = await GoogleMapsService.startNavigation(dest, (update) => {
        setNavData(update);
        if (update.currentPosition) {
          setCurrentLoc(update.currentPosition);
        } else {
          LocationService.getFreshLocation()
            .then((loc) => setCurrentLoc(loc))
            .catch(() => {});
        }
      });

      // Draw polyline
      if (routeData?.coordinates?.length > 1) {
        setRouteCoords(routeData.coordinates);
      } else if (routeData?.polyline) {
        setRouteCoords(decodePolyline(routeData.polyline));
      } else if (routeData?.steps?.length) {
        const coords = routeData.steps
          .map(s => ({
            latitude:  s.endLocation?.lat  ?? s.endLocation?.latitude,
            longitude: s.endLocation?.lng  ?? s.endLocation?.longitude,
          }))
          .filter(c => c.latitude != null && c.longitude != null);
        if (origin) coords.unshift({ latitude: origin.latitude, longitude: origin.longitude });
        setRouteCoords(coords);
      }

      setIsNavigating(true);

      // Cache route for offline access (dedup handled inside)
      OfflineModeService.cacheRouteForOffline(dest, routeData)
        .then(({ alreadyCached }) => {
          if (!alreadyCached) loadData(); // refresh offline list
        })
        .catch(() => {});

      // Start GPS recording (best-effort)
      try { await RouteMemoryService.startRecording(dest.name); } catch (_) {}

    } catch (err) {
      console.error('startNavigation error:', err);
      if (err.message !== 'destination_too_close' && err.message !== 'route_too_short') {
        await TextToSpeechService.speak('Could not start navigation. Please try again.');
      }
    }
  };

  // ── Stop navigation ────────────────────────────────────────────────────────
  const stopNavigation = async () => {
    await GoogleMapsService.stopNavigation();
    IndoorNavigationService.stopNavigation();
    setIsNavigating(false);
    setIsIndoorMode(false);
    setIndoorSteps([]);
    setIndoorStepIndex(0);
    setNavData(null);
    setRouteCoords([]);
    setSelectedDest(null);
    await TextToSpeechService.speak('Navigation stopped');
    try {
      await RouteMemoryService.stopRecording();
      await loadData();
    } catch (_) {}
  };

  // ── Indoor step advance ────────────────────────────────────────────────────
  const advanceIndoorStep = () => {
    const next = indoorStepIndex + 1;
    if (next >= indoorSteps.length) {
      setIsNavigating(false);
      setIsIndoorMode(false);
      TextToSpeechService.speak('You have arrived at your destination.');
      return;
    }
    setIndoorStepIndex(next);
    TextToSpeechService.speak(indoorSteps[next].instruction);
  };

  const repeatIndoorStep = () => {
    const step = indoorSteps[indoorStepIndex];
    if (step) TextToSpeechService.speak(step.instruction);
  };

  const repeatInstruction = () => {
    if (navData?.instruction) TextToSpeechService.speak(navData.instruction);
  };

  // ── Remove an offline route ────────────────────────────────────────────────
  const removeOffline = (item) => {
    Alert.alert(
      'Remove offline route',
      `Remove "${item.dest?.name}" from offline storage?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await OfflineModeService.removeOfflineRoute(
              item.dest.latitude,
              item.dest.longitude,
            );
            await loadData();
          },
        },
      ],
    );
  };

  // ── Map initial region ─────────────────────────────────────────────────────
  // When GPS is not yet acquired show a world-level view rather than a
  // developer's hard-coded location.
  const initialRegion = currentLoc
    ? {
        latitude:       currentLoc.latitude,
        longitude:      currentLoc.longitude,
        latitudeDelta:  0.012,
        longitudeDelta: 0.012,
      }
    : {
        latitude:       0,
        longitude:      0,
        latitudeDelta:  90,
        longitudeDelta: 90,
      };

  // ── Derived ────────────────────────────────────────────────────────────────
  const progress = navData?.currentStep && navData?.totalSteps
    ? navData.currentStep / navData.totalSteps
    : 0;
  const iconColor = maneuverColor(navData?.maneuver || navData?.direction || '');

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />

      {/* ══════════════════════════ MAP ══════════════════════════════════════ */}
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={styles.map}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton
        showsCompass
        showsTraffic={false}
        followsUserLocation={isNavigating}
      >
        {selectedDest && (
          <Marker
            coordinate={{ latitude: selectedDest.latitude, longitude: selectedDest.longitude }}
            title={selectedDest.name}
            description={selectedDest.address}
            pinColor={COLORS.danger}
          />
        )}
        {routeCoords.length > 1 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor={COLORS.primary}
            strokeWidth={5}
          />
        )}
      </MapView>

      {/* ══════════════════════════ BOTTOM PANEL ═════════════════════════════ */}
      <View style={styles.panel}>

        {/* Panel handle */}
        <View style={styles.panelHandle} />

        {isNavigating && isIndoorMode ? (
          /* ────────── INDOOR NAVIGATION VIEW ────────── */
          <ScrollView contentContainerStyle={styles.panelContent} showsVerticalScrollIndicator={false}>
            {/* Indoor mode badge */}
            <View style={styles.indoorBadge}>
              <MaterialCommunityIcons name="floor-plan" size={16} color={COLORS.primary} />
              <Text style={styles.indoorBadgeText}>Indoor Navigation</Text>
              {indoorBuilding && (
                <Text style={styles.indoorBuildingName}> · {indoorBuilding.name}</Text>
              )}
            </View>

            {/* Step counter */}
            <Text style={styles.indoorStepCounter}>
              Step {indoorStepIndex + 1} of {indoorSteps.length}
            </Text>

            {/* Current step instruction */}
            <View style={styles.indoorInstructionCard}>
              <MaterialCommunityIcons
                name="walk"
                size={28}
                color={indoorSteps[indoorStepIndex]?.isArrival ? COLORS.success : COLORS.primary}
              />
              <Text style={styles.indoorInstruction}>
                {indoorSteps[indoorStepIndex]?.instruction ?? ''}
              </Text>
            </View>

            {/* Next step preview */}
            {indoorStepIndex + 1 < indoorSteps.length && (
              <View style={styles.indoorNextStep}>
                <Text style={styles.indoorNextLabel}>Next: </Text>
                <Text style={styles.indoorNextText} numberOfLines={2}>
                  {indoorSteps[indoorStepIndex + 1]?.instruction}
                </Text>
              </View>
            )}

            {/* Destination */}
            <Text style={styles.destName} numberOfLines={1}>
              → {selectedDest?.name ?? 'Destination'}
            </Text>

            {/* Controls */}
            <View style={styles.indoorControls}>
              <TouchableOpacity style={styles.indoorBtn} onPress={repeatIndoorStep}>
                <Ionicons name="volume-medium" size={20} color={COLORS.text} />
                <Text style={styles.indoorBtnText}>Repeat</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.indoorBtn, styles.indoorBtnPrimary]}
                onPress={advanceIndoorStep}
              >
                <Ionicons name="arrow-forward" size={20} color={COLORS.dark} />
                <Text style={[styles.indoorBtnText, { color: COLORS.dark }]}>
                  {indoorStepIndex + 1 >= indoorSteps.length ? 'Arrived' : 'Next Step'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.indoorBtn} onPress={stopNavigation}>
                <Ionicons name="stop-circle" size={20} color={COLORS.danger} />
                <Text style={[styles.indoorBtnText, { color: COLORS.danger }]}>Stop</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

        ) : isNavigating ? (
          /* ────────── ACTIVE OUTDOOR NAVIGATION VIEW ────────── */
          <ScrollView
            contentContainerStyle={styles.panelContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Destination header */}
            <View style={styles.destHeader}>
              <Ionicons name="navigate" size={16} color={COLORS.primary} />
              <Text style={styles.destName} numberOfLines={1}>
                {selectedDest?.name || 'Navigating'}
              </Text>
              {!isOnline && (
                <View style={styles.offlinePill}>
                  <Ionicons name="cloud-offline-outline" size={11} color={COLORS.warning} />
                  <Text style={styles.offlinePillText}>Offline</Text>
                </View>
              )}
            </View>

            {/* Instruction card */}
            <View style={[styles.instructionCard, { borderLeftColor: iconColor }]}>
              <View style={[styles.iconCircle, { backgroundColor: iconColor + '22' }]}>
                <Ionicons
                  name={maneuverIcon(navData?.maneuver || navData?.direction)}
                  size={36}
                  color={iconColor}
                />
              </View>
              <Text style={styles.instructionText} numberOfLines={3}>
                {navData?.instruction || 'Follow the route…'}
              </Text>
            </View>

            {/* Stats strip */}
            <View style={styles.statsStrip}>
              <StatCell value={fmtDist(navData?.distanceToNextStep)} label="Next turn" />
              <View style={styles.statDivider} />
              <StatCell value={fmtDist(navData?.remainingDistance)} label="Remaining" />
              <View style={styles.statDivider} />
              <StatCell value={fmtTime(navData?.estimatedTimeMinutes)} label="ETA" />
              <View style={styles.statDivider} />
              <StatCell
                value={navData?.currentStep != null ? `${navData.currentStep}/${navData.totalSteps}` : '--'}
                label="Step"
              />
            </View>

            {/* Progress bar */}
            {progress > 0 && (
              <View style={styles.progressTrack}>
                <Animated.View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
              </View>
            )}

            {/* Controls */}
            <View style={styles.ctrlRow}>
              <TouchableOpacity
                style={styles.repeatBtn}
                onPress={repeatInstruction}
                accessibilityLabel="Repeat navigation instruction"
              >
                <Ionicons name="volume-high-outline" size={20} color={COLORS.primary} />
                <Text style={styles.repeatBtnText}>Repeat</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.stopBtn}
                onPress={stopNavigation}
                accessibilityLabel="Stop navigation"
              >
                <Ionicons name="stop-circle-outline" size={20} color="#fff" />
                <Text style={styles.stopBtnText}>Stop</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>

        ) : (
          /* ────────── SEARCH / PRE-NAV VIEW ────────── */
          <ScrollView
            contentContainerStyle={styles.panelContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Search bar */}
            <View style={styles.searchBar}>
              <Ionicons name="search-outline" size={20} color={COLORS.textSecondary} />
              <TextInput
                style={styles.searchInput}
                placeholder="Where do you want to go?"
                placeholderTextColor={COLORS.gray}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onSubmitEditing={() => triggerSearch(searchQuery, false)}
                returnKeyType="search"
                autoCorrect={false}
              />
              {searchQuery.length > 0 && !isSearching && (
                <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close-circle" size={20} color={COLORS.gray} />
                </TouchableOpacity>
              )}
              {isSearching
                ? <ActivityIndicator size="small" color={COLORS.primary} style={{ marginLeft: 4 }} />
                : (
                  <TouchableOpacity
                    onPress={() => triggerSearch(searchQuery, false)}
                    disabled={!searchQuery.trim()}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                  >
                    <Ionicons
                      name="arrow-forward-circle"
                      size={30}
                      color={searchQuery.trim() ? COLORS.primary : COLORS.gray}
                    />
                  </TouchableOpacity>
                )
              }
            </View>

            {/* ── Search results ──────────────────────────────────────────── */}
            {searchResults.length > 0 && (
              <Animated.View style={[styles.card, { opacity: resultsFade }]}>
                <SectionHeader title="Search Results" count={searchResults.length} />
                {searchResults.map((item, i) => (
                  <ResultRow
                    key={`res-${i}`}
                    icon="map-marker"
                    iconColor={COLORS.primary}
                    name={item.name}
                    sub={item.formatted_address || item.vicinity || ''}
                    onPress={() => selectAndNavigate(item)}
                    isLast={i === searchResults.length - 1}
                  />
                ))}
              </Animated.View>
            )}

            {/* ── Pinned locations ──────────────────────────────────────── */}
            {searchResults.length === 0 && pinnedLocations.length > 0 && (
              <View style={styles.card}>
                <SectionHeader title="Pinned Locations" icon="pin" />
                {pinnedLocations.map((pin, i) => (
                  <ResultRow
                    key={`pin-${pin.id}`}
                    icon={pin.buildingId ? 'business' : 'location'}
                    iconColor={COLORS.primary}
                    name={pin.displayName}
                    sub={pin.buildingId ? 'Indoor pin' : (pin.address || 'Saved location')}
                    onPress={() => {
                      PinnedLocationService.recordUsage(pin.id).catch(() => {});
                      selectAndNavigate({
                        name:      pin.displayName,
                        latitude:  pin.latitude,
                        longitude: pin.longitude,
                        formatted_address: pin.address ?? pin.displayName,
                        geometry: { location: { lat: pin.latitude, lng: pin.longitude } },
                      });
                    }}
                    isLast={i === pinnedLocations.length - 1}
                  />
                ))}
              </View>
            )}

            {/* ── Recent searches ─────────────────────────────────────────── */}
            {searchResults.length === 0 && recentSearches.length > 0 && (
              <View style={styles.card}>
                <SectionHeader title="Recent" icon="time-outline" />
                {recentSearches.map((item, i) => (
                  <ResultRow
                    key={`rec-${i}`}
                    icon="time-outline"
                    iconColor={COLORS.textSecondary}
                    name={item.name}
                    sub={item.address || ''}
                    onPress={() => {
                      setSearchQuery(item.name);
                      triggerSearch(item.name, false);
                    }}
                    isLast={i === recentSearches.length - 1}
                  />
                ))}
              </View>
            )}

            {/* ── Offline saved routes ─────────────────────────────────────── */}
            {searchResults.length === 0 && offlineRoutes.length > 0 && (
              <View style={styles.card}>
                <SectionHeader title="Available Offline" icon="cloud-done-outline" iconColor={COLORS.success} />
                {offlineRoutes.map((item, i) => (
                  <OfflineRouteRow
                    key={`off-${i}`}
                    item={item}
                    onNavigate={() => {
                      const d = item.dest;
                      setSelectedDest(d);
                      startNavigation(d);
                    }}
                    onRemove={() => removeOffline(item)}
                    isLast={i === offlineRoutes.length - 1}
                  />
                ))}
              </View>
            )}

            {/* ── Saved recorded routes ────────────────────────────────────── */}
            {searchResults.length === 0 && savedRoutes.length > 0 && (
              <View style={styles.card}>
                <SectionHeader title="Saved Routes" icon="bookmark-outline" />
                {savedRoutes.map((item, i) => (
                  <ResultRow
                    key={`sv-${i}`}
                    icon="map-marker-path"
                    iconColor={COLORS.secondary}
                    name={item.name}
                    sub={`${item.waypoints?.length || 0} waypoints · ${Math.round(item.distance || 0)} m`}
                    onPress={async () => {
                      const d = {
                        name:      item.name,
                        latitude:  item.endLocation?.latitude,
                        longitude: item.endLocation?.longitude,
                        address:   '',
                      };
                      setSelectedDest(d);
                      await startNavigation(d);
                    }}
                    iconLib="mci"
                    isLast={i === savedRoutes.length - 1}
                  />
                ))}
              </View>
            )}

            {/* ── Empty state ──────────────────────────────────────────────── */}
            {searchResults.length === 0 &&
             recentSearches.length === 0 &&
             offlineRoutes.length === 0 &&
             !isSearching && (
              <View style={styles.emptyState}>
                <View style={styles.emptyIcon}>
                  <Ionicons name="navigate-circle-outline" size={56} color={COLORS.primary + '55'} />
                </View>
                <Text style={styles.emptyTitle}>Ready to navigate</Text>
                <Text style={styles.emptyHint}>
                  Type a destination above, or say{'\n'}
                  <Text style={styles.emptyAccent}>"Hey Sensei, guide me to …"</Text>
                </Text>
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

// ─── Small shared sub-components ─────────────────────────────────────────────

function StatCell({ value, label }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statVal}>{value}</Text>
      <Text style={styles.statLbl}>{label}</Text>
    </View>
  );
}

function SectionHeader({ title, count, icon, iconColor }) {
  return (
    <View style={styles.sectionHeaderRow}>
      {icon && <Ionicons name={icon} size={14} color={iconColor || COLORS.textSecondary} style={{ marginRight: 5 }} />}
      <Text style={styles.sectionLabel}>{title}</Text>
      {count != null && count > 0 && (
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{count}</Text>
        </View>
      )}
    </View>
  );
}

function ResultRow({ icon, iconColor = COLORS.textSecondary, iconLib, name, sub, onPress, isLast }) {
  return (
    <TouchableOpacity
      style={[styles.resultRow, isLast && styles.resultRowLast]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityLabel={`Navigate to ${name}`}
    >
      <View style={[styles.rowIconWrap, { backgroundColor: iconColor + '18' }]}>
        {iconLib === 'mci'
          ? <MaterialCommunityIcons name={icon} size={18} color={iconColor} />
          : icon === 'map-marker'
            ? <MaterialCommunityIcons name={icon} size={18} color={iconColor} />
            : <Ionicons name={icon} size={18} color={iconColor} />
        }
      </View>
      <View style={styles.resultInfo}>
        <Text style={styles.resultName} numberOfLines={1}>{name}</Text>
        {!!sub && <Text style={styles.resultAddr} numberOfLines={1}>{sub}</Text>}
      </View>
      <Ionicons name="chevron-forward" size={16} color={COLORS.textSecondary} />
    </TouchableOpacity>
  );
}

function OfflineRouteRow({ item, onNavigate, onRemove, isLast }) {
  const dest = item.dest || {};
  const ago  = item.cachedAt ? _timeAgo(new Date(item.cachedAt)) : '';
  return (
    <View style={[styles.resultRow, styles.offlineRow, isLast && styles.resultRowLast]}>
      <View style={[styles.rowIconWrap, { backgroundColor: COLORS.success + '18' }]}>
        <Ionicons name="cloud-done-outline" size={18} color={COLORS.success} />
      </View>
      <View style={styles.resultInfo}>
        <Text style={styles.resultName} numberOfLines={1}>{dest.name || 'Saved route'}</Text>
        <Text style={styles.resultAddr} numberOfLines={1}>
          {dest.address ? `${dest.address} · ` : ''}{ago}
        </Text>
      </View>
      <View style={styles.offlineActions}>
        <TouchableOpacity
          onPress={onNavigate}
          style={styles.offlineNavBtn}
          accessibilityLabel={`Navigate to ${dest.name}`}
        >
          <Ionicons name="navigate" size={14} color="#fff" />
          <Text style={styles.offlineNavText}>Go</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onRemove}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel={`Remove ${dest.name} from offline`}
        >
          <Ionicons name="trash-outline" size={18} color={COLORS.gray} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function _timeAgo(date) {
  const diff = Math.round((Date.now() - date.getTime()) / 60000);
  if (diff < 1)    return 'just now';
  if (diff < 60)   return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  map: {
    height: MAP_HEIGHT,
    width: '100%',
  },

  // ── Indoor navigation styles ──────────────────────────────────────────────
  indoorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.primary + '22',
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    alignSelf: 'flex-start',
    marginBottom: SPACING.sm,
  },
  indoorBadgeText: {
    color: COLORS.primary,
    fontWeight: '700',
    fontSize: FONT_SIZES.sm,
    marginLeft: 4,
  },
  indoorBuildingName: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.sm,
  },
  indoorStepCounter: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginBottom: SPACING.sm,
  },
  indoorInstructionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.lg,
    marginBottom: SPACING.md,
    gap: SPACING.md,
    ...SHADOWS.sm,
  },
  indoorInstruction: {
    flex: 1,
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
    color: COLORS.text,
    lineHeight: 26,
  },
  indoorNextStep: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.sm,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  indoorNextLabel: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  indoorNextText: {
    flex: 1,
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
  },
  indoorControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  indoorBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md,
    gap: 6,
  },
  indoorBtnPrimary: {
    backgroundColor: COLORS.primary,
    flex: 2,
  },
  indoorBtnText: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
    color: COLORS.text,
  },

  // ── Panel shell ────────────────────────────────────────────────────────────
  panel: {
    flex: 1,
    backgroundColor: COLORS.cardBackground,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    marginTop: -BORDER_RADIUS.xl,
    ...SHADOWS.large,
  },
  panelHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  panelContent: {
    padding: SPACING.md,
    paddingBottom: 50,
  },

  // ── Active navigation ──────────────────────────────────────────────────────
  destHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  destName: {
    flex: 1,
    color: COLORS.text,
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
  },
  offlinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: COLORS.warning + '22',
    borderRadius: BORDER_RADIUS.round,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  offlinePillText: {
    fontSize: 10,
    color: COLORS.warning,
    fontWeight: '600',
  },
  instructionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    gap: SPACING.md,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.primary,
    ...SHADOWS.medium,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  instructionText: {
    flex: 1,
    fontSize: FONT_SIZES.lg,
    fontWeight: '700',
    color: COLORS.text,
    lineHeight: 26,
  },
  statsStrip: {
    flexDirection: 'row',
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    alignItems: 'center',
    ...SHADOWS.small,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
  },
  statVal: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    color: COLORS.primary,
  },
  statLbl: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: COLORS.border,
  },
  progressTrack: {
    height: 5,
    backgroundColor: COLORS.border,
    borderRadius: 3,
    marginBottom: SPACING.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.primary,
    borderRadius: 3,
  },
  ctrlRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  repeatBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: COLORS.primary + '18',
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.primary + '44',
  },
  repeatBtnText: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.primary,
  },
  stopBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: COLORS.danger,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md,
    ...SHADOWS.small,
  },
  stopBtnText: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: '#fff',
  },

  // ── Search bar ─────────────────────────────────────────────────────────────
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.md,
    height: 52,
    gap: SPACING.sm,
    ...SHADOWS.small,
  },
  searchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: FONT_SIZES.md,
  },

  // ── Cards & rows ───────────────────────────────────────────────────────────
  card: {
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
    ...SHADOWS.small,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  sectionLabel: {
    fontSize: FONT_SIZES.xs,
    fontWeight: '700',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    flex: 1,
  },
  countBadge: {
    backgroundColor: COLORS.primary + '28',
    borderRadius: BORDER_RADIUS.round,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  countBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.primary,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: SPACING.sm,
  },
  resultRowLast: {
    borderBottomWidth: 0,
  },
  rowIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultInfo: {
    flex: 1,
  },
  resultName: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
    color: COLORS.text,
  },
  resultAddr: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: 2,
  },

  // ── Offline row ────────────────────────────────────────────────────────────
  offlineRow: {
    paddingRight: SPACING.sm,
  },
  offlineActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  offlineNavBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
  },
  offlineNavText: {
    fontSize: FONT_SIZES.xs,
    fontWeight: '700',
    color: '#fff',
  },

  // ── Empty state ────────────────────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    paddingTop: SPACING.xl,
    paddingHorizontal: SPACING.xl,
  },
  emptyIcon: {
    marginBottom: SPACING.md,
  },
  emptyTitle: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
  emptyHint: {
    textAlign: 'center',
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.sm,
    lineHeight: 22,
  },
  emptyAccent: {
    color: COLORS.primary,
    fontWeight: '600',
  },
});
