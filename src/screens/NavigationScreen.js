import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, Alert, FlatList, TouchableOpacity } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Button from '../components/Button';
import Card from '../components/Card';
import NavigationService from '../services/NavigationService';
import TextToSpeechService from '../services/TextToSpeechService';
import LocationService from '../services/LocationService';
import RouteMemoryService from '../services/RouteMemoryService';
import VoiceCommandService from '../services/VoiceCommandService';
import GoogleMapsService from '../services/GoogleMapsService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';
const NavigationScreen = () => {
  const [isNavigating, setIsNavigating] = useState(false);
  const [destination, setDestination] = useState('');
  const [navigationData, setNavigationData] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [savedRoutes, setSavedRoutes] = useState([]);
  const [recentDestinations, setRecentDestinations] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [currentRecording, setCurrentRecording] = useState(null);
  useEffect(() => {
    initializeNavigation();
    return () => {
      if (isNavigating) {
        NavigationService.stopNavigation();
      }
    };
  }, []);
  
  // Periodically record waypoints during navigation
  useEffect(() => {
    let waypointInterval;
    if (isRecording && isNavigating) {
      waypointInterval = setInterval(async () => {
        try {
          const location = await LocationService.getCurrentLocation();
          await RouteMemoryService.addWaypoint(location);
          // Update current recording state
          const recording = RouteMemoryService.currentRecording;
          if (recording) {
            setCurrentRecording(recording);
          }
        } catch (error) {
          console.error('Waypoint recording error:', error);
        }
      }, 30000); // Record waypoint every 30 seconds
    }
    
    return () => {
      if (waypointInterval) {
        clearInterval(waypointInterval);
      }
    };
  }, [isRecording, isNavigating]);
  const initializeNavigation = async () => {
    try {
      await getCurrentLocationData();
      await RouteMemoryService.initialize();
      loadSavedRoutes();
      loadRecentDestinations();
    } catch (error) {
      console.error('Navigation initialization error:', error);
    }
  };
  const getCurrentLocationData = async () => {
    try {
      const location = await LocationService.getCurrentLocation();
      setCurrentLocation(location);
    } catch (error) {
      console.error('Location error:', error);
    }
  };
  const loadSavedRoutes = async () => {
    const routes = await RouteMemoryService.getSavedRoutes();
    setSavedRoutes(routes.slice(0, 5)); 
  };
  const loadRecentDestinations = () => {
    const recent = RouteMemoryService.getRecentDestinations();
    setRecentDestinations(recent.slice(0, 3));
  };
  const handleVoiceInput = async () => {
    setIsListening(true);
    TextToSpeechService.speak('Please say your destination');
    await VoiceCommandService.startListening((result) => {
      setIsListening(false);
      if (result.status === 'listening') {
      }
    });
    setTimeout(() => {
      setIsListening(false);
      Alert.prompt(
        'Voice Input',
        'Enter destination (simulated voice input)',
        [
          { text: 'Cancel', style: 'cancel' },
          { 
            text: 'OK', 
            onPress: (text) => {
              if (text) {
                setDestination(text);
                handleSearchDestination(text);
              }
            }
          }
        ]
      );
    }, 1000);
  };
  const handleSearchDestination = async (query) => {
    if (!query.trim()) return;
    try {
      TextToSpeechService.speak('Searching for destination');
      const results = await GoogleMapsService.searchPlace(query);
      if (results && results.length > 0) {
        setSearchResults(results);
        TextToSpeechService.speak(`Found ${results.length} results. Select your destination.`);
      } else {
        Alert.alert('No Results', 'No destinations found for your search');
        TextToSpeechService.speak('No destinations found');
      }
    } catch (error) {
      console.error('Search error:', error);
      Alert.alert('Error', 'Failed to search for destination');
    }
  };
  const handleSelectDestination = async (selectedDest) => {
    try {
      const destinationData = {
        name: selectedDest.name || selectedDest.formatted_address,
        latitude: selectedDest.geometry?.location?.lat || selectedDest.latitude,
        longitude: selectedDest.geometry?.location?.lng || selectedDest.longitude,
        address: selectedDest.formatted_address || selectedDest.address,
      };
      await NavigationService.startNavigation(destinationData, (navData) => {
        setNavigationData(navData);
      });
      setIsNavigating(true);
      setSearchResults([]);
      
      // Start recording route
      const recording = await RouteMemoryService.startRecording(destinationData.name);
      if (recording) {
        setIsRecording(true);
        setCurrentRecording(recording);
      }
      
      TextToSpeechService.speak(`Starting navigation to ${destinationData.name}`);
    } catch (error) {
      console.error('Navigation error:', error);
      Alert.alert('Error', 'Failed to start navigation');
      TextToSpeechService.speak('Failed to start navigation');
    }
  };
  const handleStopNavigation = async () => {
    try {
      await NavigationService.stopNavigation();
      
      // Offer to save recorded route
      if (isRecording && currentRecording) {
        Alert.alert(
          'Save Route',
          'Would you like to save this route for future use?',
          [
            {
              text: 'No',
              onPress: async () => {
                await RouteMemoryService.stopRecording();
                setIsRecording(false);
                setCurrentRecording(null);
              },
              style: 'cancel'
            },
            {
              text: 'Save',
              onPress: async () => {
                const saved = await RouteMemoryService.stopRecording();
                if (saved) {
                  TextToSpeechService.speak(`Route saved as ${saved.name}`);
                  loadSavedRoutes();
                }
                setIsRecording(false);
                setCurrentRecording(null);
              }
            }
          ]
        );
      }
      
      setIsNavigating(false);
      setNavigationData(null);
      TextToSpeechService.speak('Navigation stopped');
    } catch (error) {
      console.error('Stop navigation error:', error);
    }
  };
  const handleSaveRoute = async () => {
    if (!navigationData) return;
    Alert.prompt(
      'Save Route',
      'Enter a name for this route',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: async (routeName) => {
            if (routeName) {
              await RouteMemoryService.stopRecording();
              TextToSpeechService.speak(`Route saved as ${routeName}`);
              loadSavedRoutes();
            }
          }
        }
      ]
    );
  };
  const handleLoadSavedRoute = async (route) => {
    try {
      TextToSpeechService.speak(`Loading saved route: ${route.name}`);
      const destinationData = {
        name: route.name,
        latitude: route.endLocation.latitude,
        longitude: route.endLocation.longitude,
      };
      await NavigationService.startNavigation(destinationData, (navData) => {
        setNavigationData(navData);
      });
      setIsNavigating(true);
    } catch (error) {
      console.error('Load route error:', error);
      Alert.alert('Error', 'Failed to load saved route');
    }
  };
  const handleRepeatInstruction = () => {
    if (navigationData && navigationData.instruction) {
      TextToSpeechService.speak(navigationData.instruction);
    }
  };
  const renderSearchResult = ({ item }) => (
    <TouchableOpacity 
      style={styles.searchResultItem}
      onPress={() => handleSelectDestination(item)}
      accessible={true}
      accessibilityLabel={`Select ${item.name || item.formatted_address}`}
    >
      <MaterialCommunityIcons name="map-marker" size={24} color={COLORS.primary} />
      <View style={styles.searchResultInfo}>
        <Text style={styles.searchResultName}>{item.name || 'Unknown'}</Text>
        <Text style={styles.searchResultAddress}>{item.formatted_address || item.vicinity}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
    </TouchableOpacity>
  );
  const renderSavedRoute = ({ item }) => (
    <TouchableOpacity 
      style={styles.savedRouteItem}
      onPress={() => handleLoadSavedRoute(item)}
      accessible={true}
      accessibilityLabel={`Load saved route: ${item.name}`}
    >
      <MaterialCommunityIcons name="map-marker-path" size={24} color={COLORS.accent} />
      <View style={styles.savedRouteInfo}>
        <Text style={styles.savedRouteName}>{item.name}</Text>
        <Text style={styles.savedRouteDistance}>{Math.round(item.distance)}m · {item.waypoints?.length || 0} waypoints</Text>
      </View>
    </TouchableOpacity>
  );
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {!isNavigating ? (
        <>
          <LinearGradient
            colors={[COLORS.cardBackground, COLORS.cardBackgroundLight]}
            style={styles.header}
          >
            <MaterialCommunityIcons name="map-marker-path" size={50} color={COLORS.primary} />
            <Text style={styles.title}>Set Your Destination</Text>
            <Text style={styles.subtitle}>Enter destination to start navigation</Text>
          </LinearGradient>
          <Card 
            title="Destination" 
            variant="elevated"
            icon={<Ionicons name="location-sharp" size={24} color={COLORS.primary} />}
          >
            <View style={styles.searchContainer}>
              <TextInput
                style={styles.input}
                placeholder="Enter destination name or address"
                placeholderTextColor={COLORS.gray}
                value={destination}
                onChangeText={setDestination}
                onSubmitEditing={() => handleSearchDestination(destination)}
                accessibilityLabel="Destination input"
                accessibilityHint="Enter your destination address"
              />
              <Button
                title=""
                onPress={handleVoiceInput}
                variant="primary"
                size="small"
                icon={<Ionicons name={isListening ? "mic" : "mic-outline"} size={20} color={COLORS.dark} />}
                style={styles.voiceButton}
                gradient
                loading={isListening}
              />
            </View>
            <View style={styles.actionButtons}>
              <Button
                title="Search"
                onPress={() => handleSearchDestination(destination)}
                variant="primary"
                size="medium"
                fullWidth
                gradient
                icon={<Ionicons name="search" size={18} color={COLORS.dark} />}
              />
            </View>
          </Card>
          {searchResults.length > 0 && (
            <Card 
              title="Search Results" 
              variant="elevated"
              icon={<Ionicons name="list" size={24} color={COLORS.info} />}
            >
              <FlatList
                data={searchResults}
                renderItem={renderSearchResult}
                keyExtractor={(item, index) => index.toString()}
                scrollEnabled={false}
              />
            </Card>
          )}
          {savedRoutes.length > 0 && (
            <Card 
              title="Saved Routes" 
              variant="elevated"
              icon={<MaterialCommunityIcons name="bookmark" size={24} color={COLORS.accent} />}
            >
              <FlatList
                data={savedRoutes}
                renderItem={renderSavedRoute}
                keyExtractor={(item) => item.id.toString()}
                scrollEnabled={false}
              />
            </Card>
          )}
          {recentDestinations.length > 0 && (
            <Card 
              title="Recent Destinations" 
              variant="default"
              icon={<Ionicons name="time" size={24} color={COLORS.warning} />}
            >
              {recentDestinations.map((dest, index) => (
                <TouchableOpacity
                  key={index}
                  style={styles.recentItem}
                  onPress={() => {
                    setDestination(dest.name);
                    handleSearchDestination(dest.name);
                  }}
                >
                  <Ionicons name="location" size={20} color={COLORS.textSecondary} />
                  <Text style={styles.recentText}>{dest.name}</Text>
                </TouchableOpacity>
              ))}
            </Card>
          )}
        </>
      ) : (
        <>
          <Card 
            title="Active Navigation" 
            variant="highlighted"
            gradient
            icon={<MaterialCommunityIcons name="navigation" size={24} color={COLORS.primary} />}
          >
            <View style={styles.navigationInfo}>
              <View style={styles.instructionContainer}>
                <Ionicons name="arrow-forward-circle" size={32} color={COLORS.primary} />
                <Text style={styles.instruction}>{navigationData?.instruction}</Text>
              </View>
              <View style={styles.statsContainer}>
                <View style={styles.statBox}>
                  <Ionicons name="walk" size={24} color={COLORS.accent} />
                  <Text style={styles.statValue}>{navigationData?.distanceToNextStep}m</Text>
                  <Text style={styles.statLabel}>To Next Step</Text>
                </View>
                <View style={styles.statBox}>
                  <Ionicons name="compass" size={24} color={COLORS.accent} />
                  <Text style={styles.statValue}>{navigationData?.direction}</Text>
                  <Text style={styles.statLabel}>Direction</Text>
                </View>
                <View style={styles.statBox}>
                  <Ionicons name="flag" size={24} color={COLORS.accent} />
                  <Text style={styles.statValue}>{navigationData?.remainingDistance}m</Text>
                  <Text style={styles.statLabel}>Remaining</Text>
                </View>
              </View>
            </View>
          </Card>
          {isRecording && currentRecording && (
            <Card 
              title="Recording Route" 
              variant="elevated"
              icon={<MaterialCommunityIcons name="record-circle" size={24} color={COLORS.danger} />}
            >
              <View style={styles.recordingInfo}>
                <View style={styles.recordingIndicator}>
                  <View style={styles.recordingDot} />
                  <Text style={styles.recordingText}>Recording: {currentRecording.name}</Text>
                </View>
                <Text style={styles.recordingStats}>
                  Waypoints: {currentRecording.waypoints?.length || 0}
                </Text>
              </View>
            </Card>
          )}
          
          <Card 
            title="Route Progress" 
            variant="default"
            icon={<MaterialCommunityIcons name="progress-clock" size={24} color={COLORS.info} />}
          >
            <View style={styles.progressBar}>
              <View 
                style={[
                  styles.progressFill, 
                  { 
                    width: `${(navigationData?.currentStep / navigationData?.totalSteps) * 100}%` 
                  }
                ]} 
              />
            </View>
            <View style={styles.infoRow}>
              <View style={styles.infoLeft}>
                <MaterialCommunityIcons name="map-marker-distance" size={16} color={COLORS.accent} />
                <Text style={styles.label}>Step</Text>
              </View>
              <Text style={styles.value}>
                {navigationData?.currentStep} of {navigationData?.totalSteps}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <View style={styles.infoLeft}>
                <Ionicons name="time" size={16} color={COLORS.accent} />
                <Text style={styles.label}>Est. Time</Text>
              </View>
              <Text style={styles.value}>
                {navigationData?.estimatedTimeMinutes || 0} min
              </Text>
            </View>
            <View style={styles.infoRow}>
              <View style={styles.infoLeft}>
                <Ionicons name="speedometer" size={16} color={COLORS.accent} />
                <Text style={styles.label}>Speed</Text>
              </View>
              <Text style={styles.value}>
                {(navigationData?.currentSpeed * 3.6).toFixed(1)} km/h
              </Text>
            </View>
          </Card>
          <Card 
            title="Navigation Controls" 
            variant="default"
            icon={<Ionicons name="settings" size={24} color={COLORS.warning} />}
          >
            <View style={styles.controlButtons}>
              <Button
                title="Repeat Instruction"
                onPress={handleRepeatInstruction}
                variant="secondary"
                size="medium"
                fullWidth
                icon={<Ionicons name="volume-high" size={18} color={COLORS.text} />}
              />
              <View style={styles.buttonSpacing} />
              <Button
                title="Save Route"
                onPress={handleSaveRoute}
                variant="secondary"
                size="medium"
                fullWidth
                icon={<Ionicons name="bookmark" size={18} color={COLORS.text} />}
              />
              <View style={styles.buttonSpacing} />
              <Button
                title="Stop Navigation"
                onPress={handleStopNavigation}
                variant="danger"
                size="medium"
                fullWidth
                icon={<Ionicons name="stop-circle" size={18} color={COLORS.text} />}
              />
            </View>
          </Card>
        </>
      )}
      {currentLocation && (
        <Card 
          title="Current Location" 
          variant="default"
          icon={<Ionicons name="locate" size={24} color={COLORS.success} />}
        >
          <View style={styles.locationRow}>
            <Text style={styles.locationLabel}>Latitude:</Text>
            <Text style={styles.locationValue}>{currentLocation.latitude.toFixed(6)}</Text>
          </View>
          <View style={styles.locationRow}>
            <Text style={styles.locationLabel}>Longitude:</Text>
            <Text style={styles.locationValue}>{currentLocation.longitude.toFixed(6)}</Text>
          </View>
          <View style={styles.locationRow}>
            <Text style={styles.locationLabel}>Accuracy:</Text>
            <Text style={styles.locationValue}>{currentLocation.accuracy?.toFixed(1)}m</Text>
          </View>
        </Card>
      )}
    </ScrollView>
  );
};
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: SPACING.lg,
    paddingBottom: 32,
  },
  header: {
    alignItems: 'center',
    marginVertical: SPACING.xl,
    paddingVertical: SPACING.xl,
    borderRadius: BORDER_RADIUS.lg,
    paddingHorizontal: SPACING.lg,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: SPACING.md,
  },
  subtitle: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '400',
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.cardBackgroundLight,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  voiceButton: {
    paddingHorizontal: SPACING.md,
  },
  actionButtons: {
    marginTop: SPACING.sm,
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  searchResultInfo: {
    flex: 1,
    marginLeft: SPACING.md,
  },
  searchResultName: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    fontWeight: '600',
  },
  searchResultAddress: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs / 2,
  },
  savedRouteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  savedRouteInfo: {
    flex: 1,
    marginLeft: SPACING.md,
  },
  savedRouteName: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    fontWeight: '600',
  },
  savedRouteDistance: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs / 2,
  },
  recentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  recentText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
    marginLeft: SPACING.sm,
  },
  buttonSpacing: {
    height: SPACING.md,
  },
  navigationInfo: {
    marginTop: SPACING.md,
  },
  instructionContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.lg,
    padding: SPACING.md,
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
  },
  instruction: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '700',
    color: COLORS.primary,
    marginLeft: SPACING.md,
    flex: 1,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: SPACING.md,
  },
  statBox: {
    alignItems: 'center',
    padding: SPACING.md,
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.md,
    flex: 1,
    marginHorizontal: SPACING.xs,
  },
  statValue: {
    fontSize: FONT_SIZES.xl,
    fontWeight: 'bold',
    color: COLORS.text,
    marginTop: SPACING.xs,
  },
  statLabel: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  progressBar: {
    height: 8,
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.sm,
    marginVertical: SPACING.md,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.primary,
    borderRadius: BORDER_RADIUS.sm,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  infoLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
    marginLeft: SPACING.sm,
  },
  value: {
    fontSize: FONT_SIZES.md,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  recordingInfo: {
    padding: SPACING.md,
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.danger,
    marginRight: SPACING.sm,
  },
  recordingText: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    fontWeight: '600',
  },
  recordingStats: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  controlButtons: {
    marginTop: SPACING.md,
  },
  locationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  locationLabel: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
    color: COLORS.text,
  },
  locationValue: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    fontFamily: 'monospace',
  },
});
export default NavigationScreen;
