import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Dimensions } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Button from '../components/Button';
import Card from '../components/Card';
import LocationService from '../services/LocationService';
import TextToSpeechService from '../services/TextToSpeechService';
import ObjectDetectionService from '../services/ObjectDetectionService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';
const { width, height } = Dimensions.get('window');
const HomeScreen = ({ navigation }) => {
  const [locationStatus, setLocationStatus] = useState('Not available');
  const [detectionActive, setDetectionActive] = useState(false);
  const [nearbyObjects, setNearbyObjects] = useState([]);
  useEffect(() => {
    initializeServices();
    return () => {
      ObjectDetectionService.stopDetection();
    };
  }, []);
  const initializeServices = async () => {
    try {
      const hasLocationPermission = await LocationService.requestPermissions();
      if (hasLocationPermission) {
        const location = await LocationService.getCurrentLocation();
        setLocationStatus(`${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`);
      }
    } catch (error) {
      console.error('Initialization error:', error);
      TextToSpeechService.speak('Failed to initialize location services');
    }
  };
  const handleStartDetection = async () => {
    if (!detectionActive) {
      try {
        await ObjectDetectionService.startDetection((detections) => {
          setNearbyObjects(detections);
          if (detections.length > 0) {
            const description = ObjectDetectionService.getObjectDescription(detections[0]);
            TextToSpeechService.speak(description);
          }
        });
        setDetectionActive(true);
        TextToSpeechService.speak('Object detection started');
      } catch (error) {
        console.error('Detection error:', error);
        TextToSpeechService.speak('Failed to start object detection');
      }
    } else {
      ObjectDetectionService.stopDetection();
      setDetectionActive(false);
      setNearbyObjects([]);
      TextToSpeechService.speak('Object detection stopped');
    }
  };
  const handleNavigateToDestination = () => {
    TextToSpeechService.speak('Opening navigation');
    navigation.navigate('Navigation');
  };
  const handleOpenAR = () => {
    TextToSpeechService.speak('Opening AR view');
    navigation.navigate('AR');
  };
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <LinearGradient
        colors={[COLORS.gradient1, COLORS.gradient2]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <MaterialCommunityIcons name="eye-outline" size={60} color={COLORS.text} />
        <Text style={styles.title}>SENSEI</Text>
        <Text style={styles.subtitle}>Smart Environmental Navigation System</Text>
      </LinearGradient>
      <Card
        title="Quick Actions"
        variant="elevated"
        icon={<Ionicons name="flash" size={24} color={COLORS.primary} />}
      >
        <View style={styles.buttonGroup}>
          <Button
            title="Start Navigation"
            onPress={handleNavigateToDestination}
            variant="primary"
            size="small"
            fullWidth
            gradient
            icon={<Ionicons name="navigate" size={18} color={COLORS.dark} />}
          />
          <View style={styles.buttonSpacing} />
          <Button
            title="Open AR View"
            onPress={handleOpenAR}
            variant="secondary"
            size="medium"
            fullWidth
            icon={<Ionicons name="scan" size={18} color={COLORS.text} />}
          />
          <View style={styles.buttonSpacing} />
          <Button
            title={detectionActive ? 'Stop Detection' : 'Start Detection'}
            onPress={handleStartDetection}
            variant={detectionActive ? 'danger' : 'success'}
            size="medium"
            fullWidth
            icon={<Ionicons name={detectionActive ? 'stop-circle' : 'play-circle'} size={18} color={COLORS.text} />}
          />
        </View>
      </Card>
      <Card 
        title="Current Location" 
        variant="default"
        icon={<Ionicons name="location" size={24} color={COLORS.accent} />}
      >
        <Text style={styles.infoText}>{locationStatus}</Text>
      </Card>
      {nearbyObjects.length > 0 && (
        <Card 
          title="Nearby Objects" 
          variant="highlighted"
          gradient
          icon={<MaterialCommunityIcons name="radar" size={24} color={COLORS.primary} />}
        >
          {nearbyObjects.map((obj, index) => (
            <View key={index} style={styles.objectItem}>
              <View style={styles.objectIcon}>
                <MaterialCommunityIcons 
                  name={getObjectIcon(obj.class)} 
                  size={20} 
                  color={COLORS.primary} 
                />
              </View>
              <View style={styles.objectInfo}>
                <Text style={styles.objectText}>
                  {obj.class}
                </Text>
                <Text style={styles.objectDistance}>
                  {obj.distance.toFixed(1)}m {obj.position.relative}
                </Text>
              </View>
            </View>
          ))}
        </Card>
      )}
      <Card 
        title="System Status" 
        variant="default"
        icon={<Ionicons name="information-circle" size={24} color={COLORS.info} />}
      >
        <View style={styles.statusRow}>
          <View style={styles.statusLeft}>
            <Ionicons name="location-sharp" size={16} color={COLORS.success} />
            <Text style={styles.statusLabel}>Location</Text>
          </View>
          <View style={styles.statusBadge}>
            <Text style={styles.statusValue}>Active</Text>
          </View>
        </View>
        <View style={styles.statusRow}>
          <View style={styles.statusLeft}>
            <Ionicons name="eye" size={16} color={detectionActive ? COLORS.success : COLORS.gray} />
            <Text style={styles.statusLabel}>Detection</Text>
          </View>
          <View style={[styles.statusBadge, !detectionActive && styles.inactiveBadge]}>
            <Text style={styles.statusValue}>
              {detectionActive ? 'Active' : 'Inactive'}
            </Text>
          </View>
        </View>
        <View style={styles.statusRow}>
          <View style={styles.statusLeft}>
            <MaterialCommunityIcons name="augmented-reality" size={16} color={COLORS.success} />
            <Text style={styles.statusLabel}>AR</Text>
          </View>
          <View style={styles.statusBadge}>
            <Text style={styles.statusValue}>Ready</Text>
          </View>
        </View>
      </Card>
    </ScrollView>
  );
};
const getObjectIcon = (objectClass) => {
  const iconMap = {
    'person': 'account',
    'car': 'car',
    'bus': 'bus',
    'truck': 'truck',
    'bicycle': 'bike',
    'motorcycle': 'motorbike',
    'traffic light': 'traffic-light',
    'stop sign': 'stop-circle',
    'door': 'door',
    'chair': 'seat',
    'table': 'table-furniture',
    'laptop': 'laptop',
    'bottle': 'bottle-tonic',
    'cup': 'cup',
  };
  return iconMap[objectClass] || 'shape';
};
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxl,
  },
  header: {
    alignItems: 'center',
    marginVertical: SPACING.xl,
    paddingVertical: SPACING.xxl,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.lg,
  },
  title: {
    fontSize: 36,
    fontWeight: '900',
    color: COLORS.text,
    marginTop: SPACING.md,
    letterSpacing: 2,
  },
  subtitle: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '500',
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: SPACING.xs,
  },
  buttonGroup: {
    marginTop: SPACING.md,
  },
  buttonSpacing: {
    height: SPACING.md,
  },
  infoText: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    marginTop: SPACING.sm,
    fontFamily: 'monospace',
  },
  objectItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  objectIcon: {
    width: 40,
    height: 40,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.cardBackground,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.md,
  },
  objectInfo: {
    flex: 1,
  },
  objectText: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  objectDistance: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusLabel: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
    marginLeft: SPACING.sm,
  },
  statusBadge: {
    backgroundColor: COLORS.success,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
  },
  inactiveBadge: {
    backgroundColor: COLORS.gray,
  },
  statusValue: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
    fontWeight: '700',
  },
});
export default HomeScreen;
