import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  FlatList, ActivityIndicator, Dimensions, ScrollView, Platform,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import GoogleMapsService from '../services/GoogleMapsService';
import LocationService from '../services/LocationService';
import TextToSpeechService from '../services/TextToSpeechService';
import RouteMemoryService from '../services/RouteMemoryService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const MAP_HEIGHT = Math.round(SCREEN_HEIGHT * 0.42);

// ── Google-encoded polyline decoder ──────────────────────────────────────────
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

// ── Map maneuver → icon ───────────────────────────────────────────────────────
function maneuverIcon(maneuver = '') {
  if (maneuver.includes('left'))       return 'arrow-back-circle';
  if (maneuver.includes('right'))      return 'arrow-forward-circle';
  if (maneuver.includes('uturn'))      return 'return-down-back';
  if (maneuver.includes('roundabout')) return 'refresh-circle';
  if (maneuver.includes('merge'))      return 'git-merge';
  return 'arrow-up-circle';
}

// ─────────────────────────────────────────────────────────────────────────────
export default function NavigationScreen() {
  const route      = useRoute();
  const navigation = useNavigation();
  const mapRef     = useRef(null);
  const lastParamRef = useRef(null);   // prevents double-processing same param

  // ── State ────────────────────────────────────────────────────────────────
  const [searchQuery,    setSearchQuery]    = useState('');
  const [searchResults,  setSearchResults]  = useState([]);
  const [isSearching,    setIsSearching]    = useState(false);
  const [isNavigating,   setIsNavigating]   = useState(false);
  const [navData,        setNavData]        = useState(null);
  const [selectedDest,   setSelectedDest]   = useState(null);
  const [routeCoords,    setRouteCoords]    = useState([]);
  const [currentLoc,     setCurrentLoc]     = useState(null);
  const [savedRoutes,    setSavedRoutes]    = useState([]);
  const [recentDests,    setRecentDests]    = useState([]);

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const loc = await LocationService.getCurrentLocation();
        setCurrentLoc(loc);
        await RouteMemoryService.initialize();
        setSavedRoutes((await RouteMemoryService.getSavedRoutes()).slice(0, 5));
        setRecentDests(RouteMemoryService.getRecentDestinations().slice(0, 3));
      } catch (e) {
        console.error('NavigationScreen init error:', e);
      }
    })();
    return () => { GoogleMapsService.stopNavigation(); };
  }, []);

  // ── React to incoming voice-command params every time screen is focused ──
  useFocusEffect(
    useCallback(() => {
      const params = route.params;
      const paramKey = params?.destination;
      if (paramKey && paramKey !== lastParamRef.current) {
        lastParamRef.current = paramKey;
        setSearchQuery(paramKey);
        triggerSearch(paramKey, params.autoNavigate ?? false);
        // Clear params so navigating back & forth doesn't re-trigger
        navigation.setParams({ destination: undefined, autoNavigate: undefined });
      }
    }, [route.params]) // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Fit map to decoded route ──────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current && routeCoords.length > 1) {
      mapRef.current.fitToCoordinates(routeCoords, {
        edgePadding: { top: 80, right: 50, bottom: 50, left: 50 },
        animated: true,
      });
    }
  }, [routeCoords]);

  // ── Search ───────────────────────────────────────────────────────────────
  const triggerSearch = async (query, autoNavigate) => {
    if (!query?.trim()) return;
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
          await TextToSpeechService.speak(
            `Found ${results.length} result${results.length > 1 ? 's' : ''} for ${query}. Tap one to navigate.`
          );
        }
      } else {
        // No results from Places OR Geocoding API — tell user clearly
        await TextToSpeechService.speak(
          `Could not find ${query}. Check your internet connection or try a more specific address.`
        );
      }
    } catch (err) {
      console.error('NavigationScreen search error:', err);
      await TextToSpeechService.speak('Search failed. Please check your connection and try again.');
    } finally {
      setIsSearching(false);
    }
  };

  // ── Select result → navigate ─────────────────────────────────────────────
  const selectAndNavigate = async (place) => {
    const dest = {
      name:      place.name || place.formatted_address || 'Destination',
      latitude:  place.geometry?.location?.lat ?? place.latitude,
      longitude: place.geometry?.location?.lng ?? place.longitude,
      address:   place.formatted_address || place.vicinity || '',
    };
    setSelectedDest(dest);
    setSearchResults([]);
    await startNavigation(dest);
  };

  // ── Start turn-by-turn navigation ────────────────────────────────────────
  const startNavigation = async (dest) => {
    try {
      await TextToSpeechService.speak(`Starting navigation to ${dest.name}`);

      const origin = currentLoc || await LocationService.getCurrentLocation();

      // Single call: GoogleMapsService.startNavigation fetches directions
      // internally AND begins live GPS tracking.  It returns the current route
      // so we can decode the polyline here — no second getDirections call needed.
      const routeData = await GoogleMapsService.startNavigation(dest, (update) => {
        setNavData(update);
        // Keep current location state fresh for map re-centre
        LocationService.getCurrentLocation()
          .then(loc => setCurrentLoc(loc))
          .catch(() => {});
      });

      // Draw the route on the map
      // OSRM returns routeData.coordinates (ready-to-use array).
      // Google Directions returns routeData.polyline (encoded string).
      if (routeData?.coordinates?.length > 1) {
        setRouteCoords(routeData.coordinates);
      } else if (routeData?.polyline) {
        setRouteCoords(decodePolyline(routeData.polyline));
      } else if (routeData?.steps?.length) {
        // Fallback: build crude polyline from step endpoints
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

      // Start route recording (best-effort — don't let failure abort navigation)
      try { await RouteMemoryService.startRecording(dest.name); } catch (_) {}

    } catch (err) {
      console.error('startNavigation error:', err);
      await TextToSpeechService.speak('Could not start navigation. Please try again.');
    }
  };

  // ── Stop navigation ───────────────────────────────────────────────────────
  const stopNavigation = async () => {
    await GoogleMapsService.stopNavigation();
    setIsNavigating(false);
    setNavData(null);
    setRouteCoords([]);
    setSelectedDest(null);
    await TextToSpeechService.speak('Navigation stopped');
    try {
      await RouteMemoryService.stopRecording();
      setSavedRoutes((await RouteMemoryService.getSavedRoutes()).slice(0, 5));
    } catch (_) {}
  };

  const repeatInstruction = () => {
    if (navData?.instruction) TextToSpeechService.speak(navData.instruction);
  };

  // ── Render helpers ────────────────────────────────────────────────────────
  const renderResult = ({ item }) => (
    <TouchableOpacity
      style={styles.resultRow}
      onPress={() => selectAndNavigate(item)}
      accessibilityLabel={`Navigate to ${item.name}`}
    >
      <MaterialCommunityIcons name="map-marker" size={22} color={COLORS.primary} />
      <View style={styles.resultInfo}>
        <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.resultAddr} numberOfLines={1}>
          {item.formatted_address || item.vicinity || ''}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={COLORS.textSecondary} />
    </TouchableOpacity>
  );

  const renderSavedRoute = ({ item }) => (
    <TouchableOpacity
      style={styles.resultRow}
      onPress={async () => {
        const dest = {
          name: item.name,
          latitude: item.endLocation?.latitude,
          longitude: item.endLocation?.longitude,
        };
        setSelectedDest(dest);
        await startNavigation(dest);
      }}
      accessibilityLabel={`Load route ${item.name}`}
    >
      <MaterialCommunityIcons name="map-marker-path" size={22} color={COLORS.accent} />
      <View style={styles.resultInfo}>
        <Text style={styles.resultName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.resultAddr}>{item.waypoints?.length || 0} waypoints</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={COLORS.textSecondary} />
    </TouchableOpacity>
  );

  // ── Map initial region (Pakistan default, replaced once location is known) ─
  const initialRegion = currentLoc
    ? {
        latitude:       currentLoc.latitude,
        longitude:      currentLoc.longitude,
        latitudeDelta:  0.012,
        longitudeDelta: 0.012,
      }
    : {
        latitude:       33.6844,
        longitude:      73.0479,
        latitudeDelta:  0.05,
        longitudeDelta: 0.05,
      };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* ══════════════════════════ MAP ══════════════════════════════════ */}
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
        {/* Destination pin */}
        {selectedDest && (
          <Marker
            coordinate={{ latitude: selectedDest.latitude, longitude: selectedDest.longitude }}
            title={selectedDest.name}
            description={selectedDest.address}
            pinColor="red"
          />
        )}

        {/* Route polyline */}
        {routeCoords.length > 1 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor={COLORS.primary}
            strokeWidth={5}
            lineDashPattern={null}
          />
        )}
      </MapView>

      {/* ══════════════════════════ BOTTOM PANEL ═════════════════════════ */}
      <ScrollView
        style={styles.panel}
        contentContainerStyle={styles.panelContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >

        {/* ──────── ACTIVE NAVIGATION VIEW ──────── */}
        {isNavigating ? (
          <>
            {/* Turn instruction */}
            <View style={styles.instructionCard}>
              <Ionicons
                name={maneuverIcon(navData?.maneuver || navData?.direction)}
                size={40}
                color={COLORS.primary}
              />
              <Text style={styles.instructionText} numberOfLines={3}>
                {navData?.instruction || 'Follow the route…'}
              </Text>
            </View>

            {/* Stats strip */}
            <View style={styles.statsStrip}>
              <View style={styles.stat}>
                <Text style={styles.statVal}>
                  {navData?.distanceToNextStep != null ? `${navData.distanceToNextStep}m` : '--'}
                </Text>
                <Text style={styles.statLbl}>Next turn</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statVal}>
                  {navData?.remainingDistance != null ? `${navData.remainingDistance}m` : '--'}
                </Text>
                <Text style={styles.statLbl}>Remaining</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statVal}>
                  {navData?.estimatedTimeMinutes != null ? `${navData.estimatedTimeMinutes} min` : '--'}
                </Text>
                <Text style={styles.statLbl}>ETA</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statVal}>
                  {navData?.currentStep != null
                    ? `${navData.currentStep}/${navData.totalSteps}`
                    : '--'}
                </Text>
                <Text style={styles.statLbl}>Step</Text>
              </View>
            </View>

            {/* Progress bar */}
            {navData?.currentStep != null && navData?.totalSteps > 0 && (
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${(navData.currentStep / navData.totalSteps) * 100}%` },
                  ]}
                />
              </View>
            )}

            {/* Control buttons */}
            <View style={styles.ctrlRow}>
              <TouchableOpacity style={styles.repeatBtn} onPress={repeatInstruction}>
                <Ionicons name="volume-high" size={20} color={COLORS.text} />
                <Text style={styles.ctrlBtnText}>Repeat</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.stopBtn} onPress={stopNavigation}>
                <Ionicons name="stop-circle" size={20} color="#fff" />
                <Text style={[styles.ctrlBtnText, styles.ctrlBtnTextLight]}>Stop</Text>
              </TouchableOpacity>
            </View>
          </>

        ) : (
          /* ──────── SEARCH / PRE-NAV VIEW ──────── */
          <>
            {/* Search bar */}
            <View style={styles.searchBar}>
              <Ionicons name="search" size={20} color={COLORS.textSecondary} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search destination…"
                placeholderTextColor={COLORS.gray}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onSubmitEditing={() => triggerSearch(searchQuery, false)}
                returnKeyType="search"
                autoCorrect={false}
              />
              {isSearching
                ? <ActivityIndicator size="small" color={COLORS.primary} style={{ marginLeft: 6 }} />
                : (
                  <TouchableOpacity
                    onPress={() => triggerSearch(searchQuery, false)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="arrow-forward-circle" size={30} color={COLORS.primary} />
                  </TouchableOpacity>
                )
              }
            </View>

            {/* Search results */}
            {searchResults.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Results</Text>
                <FlatList
                  data={searchResults}
                  renderItem={renderResult}
                  keyExtractor={(_, i) => `r${i}`}
                  scrollEnabled={false}
                />
              </View>
            )}

            {/* Saved routes */}
            {searchResults.length === 0 && savedRoutes.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Saved Routes</Text>
                <FlatList
                  data={savedRoutes}
                  renderItem={renderSavedRoute}
                  keyExtractor={(item) => item.id?.toString() ?? Math.random().toString()}
                  scrollEnabled={false}
                />
              </View>
            )}

            {/* Recent destinations */}
            {searchResults.length === 0 && recentDests.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Recent</Text>
                {recentDests.map((d, i) => (
                  <TouchableOpacity
                    key={i}
                    style={styles.resultRow}
                    onPress={() => { setSearchQuery(d.name); triggerSearch(d.name, false); }}
                  >
                    <Ionicons name="time-outline" size={20} color={COLORS.textSecondary} />
                    <Text style={[styles.resultName, { marginLeft: 10, flex: 1 }]} numberOfLines={1}>
                      {d.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Empty-state hint */}
            {searchResults.length === 0 && !isSearching && (
              <Text style={styles.hint}>
                Say "Hey Sensei" then:{'\n'}
                • "Guide me to COMSATS University"{'\n'}
                • "Find location hospital"{'\n'}
                {'\n'}
                Or type a destination above.
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
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
  panel: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  panelContent: {
    padding: SPACING.md,
    paddingBottom: 40,
  },

  // ── Navigation view ────────────────────────────────────────────────────
  instructionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.sm,
    gap: SPACING.md,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
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
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    alignItems: 'center',
  },
  stat: {
    flex: 1,
    alignItems: 'center',
  },
  statVal: {
    fontSize: FONT_SIZES.md,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  statLbl: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 30,
    backgroundColor: COLORS.border,
  },
  progressBar: {
    height: 6,
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
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
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
  },
  ctrlBtnText: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
  },
  ctrlBtnTextLight: {
    color: '#fff',
  },

  // ── Search view ────────────────────────────────────────────────────────
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.md,
    height: 54,
    gap: SPACING.sm,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  searchInput: {
    flex: 1,
    color: COLORS.text,
    fontSize: FONT_SIZES.md,
  },
  card: {
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  sectionLabel: {
    fontSize: FONT_SIZES.xs,
    fontWeight: '700',
    color: COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: SPACING.sm,
  },
  resultInfo: {
    flex: 1,
  },
  resultName: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
  },
  resultAddr: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  hint: {
    textAlign: 'center',
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.sm,
    marginTop: SPACING.xl,
    lineHeight: 24,
    paddingHorizontal: SPACING.lg,
  },
});
