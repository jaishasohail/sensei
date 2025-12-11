import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, Alert, TouchableOpacity, Vibration } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Button from '../components/Button';
import Card from '../components/Card';
import BluetoothService from '../services/BluetoothService';
import TextToSpeechService from '../services/TextToSpeechService';
import SettingsService from '../services/SettingsService';
import ObjectDetectionService from '../services/ObjectDetectionService';
import EmergencyService from '../services/EmergencyService';
import ApiService from '../services/ApiService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';
const SettingsScreen = ({ navigation }) => {
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [hapticEnabled, setHapticEnabled] = useState(true);
  const [bluetoothEnabled, setBluetoothEnabled] = useState(false);
  const [connectedDevices, setConnectedDevices] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [precisionMode, setPrecisionMode] = useState(true);
  const [refinementPass, setRefinementPass] = useState(false);
  const [fallDetectionEnabled, setFallDetectionEnabled] = useState(false);
  const [emergencyContactsCount, setEmergencyContactsCount] = useState(0);
  const [userProfile, setUserProfile] = useState(null);
  const [userPreferences, setUserPreferences] = useState(null);
  useEffect(() => {
    initializeSettings();
  }, []);
  const initializeSettings = async () => {
    await BluetoothService.initialize();
    await EmergencyService.initialize();
    loadConnectedDevices();
    loadEmergencyContactsCount();
    loadDetectionSettings();
    await loadUserData();
  };

  const loadUserData = async () => {
    try {
      // In a real app, you'd get the user ID from auth context
      // For now, we'll skip this if no user is logged in
      if (ApiService.token) {
        // User data would be loaded here
        // const profile = await ApiService.getUserProfile(userId);
        // setUserProfile(profile);
      }
    } catch (error) {
      console.error('Failed to load user data:', error);
    }
  };
  const loadConnectedDevices = () => {
    const devices = BluetoothService.getConnectedDevices();
    setConnectedDevices(devices);
    setBluetoothEnabled(devices.length > 0);
  };
  const loadEmergencyContactsCount = () => {
    const contacts = EmergencyService.getEmergencyContacts();
    setEmergencyContactsCount(contacts.length);
  };
  const loadDetectionSettings = async () => {
    const s = await SettingsService.getSettings();
    setPrecisionMode(!!s.precisionMode);
    setRefinementPass(!!s.refinementPass);
    setFallDetectionEnabled(!!s.fallDetectionEnabled);
  };
  const handleAudioToggle = (value) => {
    setAudioEnabled(value);
    const message = value ? 'Audio enabled' : 'Audio disabled';
    if (ttsEnabled) {
      TextToSpeechService.speak(message);
    }
  };
  const handleTTSToggle = (value) => {
    setTtsEnabled(value);
    if (value) {
      TextToSpeechService.speak('Text to speech enabled');
    }
  };
  const handleHapticToggle = (value) => {
    setHapticEnabled(value);
    if (ttsEnabled) {
      TextToSpeechService.speak(value ? 'Haptic feedback enabled' : 'Haptic feedback disabled');
    }
  };
  const handleScanDevices = async () => {
    if (isScanning) {
      return;
    }
    setIsScanning(true);
    if (ttsEnabled) {
      TextToSpeechService.speak('Scanning for Bluetooth devices');
    }
    try {
      const foundDevices = [];
      await BluetoothService.startScan((device) => {
        if (!foundDevices.find(d => d.id === device.id)) {
          foundDevices.push(device);
        }
      }, 10000);
      setTimeout(() => {
        setIsScanning(false);
        if (ttsEnabled) {
          TextToSpeechService.speak(`Found ${foundDevices.length} devices`);
        }
        if (foundDevices.length === 0) {
          Alert.alert('Scan Complete', 'No devices found');
        }
      }, 10000);
    } catch (error) {
      console.error('Scan error:', error);
      setIsScanning(false);
      Alert.alert('Error', 'Failed to scan for devices');
    }
  };
  const handleDisconnectAll = async () => {
    try {
      await BluetoothService.disconnectAll();
      setConnectedDevices([]);
      setBluetoothEnabled(false);
      if (ttsEnabled) {
        TextToSpeechService.speak('All devices disconnected');
      }
    } catch (error) {
      console.error('Disconnect error:', error);
      Alert.alert('Error', 'Failed to disconnect devices');
    }
  };
  const handleTestAudio = () => {
    TextToSpeechService.speak('This is a test of the audio system. SENSEI is ready to assist you.');
  };
  const applyDetectionConfig = async (partial) => {
    const s = await SettingsService.saveSettings(partial);
    const precision = !!s.precisionMode;
    try {
      ObjectDetectionService.setConfig({
        scoreThreshold: precision ? 0.5 : 0.35,
        nmsIoUThreshold: precision ? 0.5 : 0.45,
        perClassNMS: true,
        smoothingFactor: precision ? 0.6 : 0.5,
        maxDetections: s.maxDetections ?? (precision ? 15 : 20),
        horizontalFOV: s.horizontalFOV ?? 70,
        verticalFOV: s.verticalFOV ?? 60,
        enableRefinementPass: !!s.refinementPass,
      });
    } catch {}
  };
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>Customize your SENSEI experience</Text>
      </View>
      <Card 
        title="Emergency" 
        variant="elevated"
        icon={<MaterialCommunityIcons name="alert-circle" size={24} color={COLORS.danger} />}
      >
        <TouchableOpacity
          style={styles.navigationItem}
          onPress={() => navigation.navigate('EmergencyContacts')}
        >
          <View style={styles.navigationLeft}>
            <MaterialCommunityIcons name="account-multiple" size={24} color={COLORS.primary} />
            <View style={styles.navigationInfo}>
              <Text style={styles.navigationTitle}>Emergency Contacts</Text>
              <Text style={styles.navigationSubtitle}>{emergencyContactsCount} contact{emergencyContactsCount !== 1 ? 's' : ''}</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
        </TouchableOpacity>
        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Fall Detection</Text>
          <Switch
            value={fallDetectionEnabled}
            onValueChange={async (v) => {
              setFallDetectionEnabled(v);
              await SettingsService.saveSettings({ fallDetectionEnabled: v });
              if (v) {
                EmergencyService.enableFallDetection();
              } else {
                EmergencyService.disableFallDetection();
              }
            }}
            trackColor={{ false: '#D1D1D6', true: '#FF3B30' }}
            thumbColor="#FFFFFF"
          />
        </View>
        <Button
          title="Test Emergency Alert"
          onPress={() => {
            Vibration.vibrate([0, 500, 200, 500, 200, 1000]);
            TextToSpeechService.speak('Testing emergency alert system');
            Alert.alert(
              'Test Emergency Alert',
              'This will test the emergency alert system without sending actual messages.',
              [
                { text: 'Cancel', style: 'cancel' },
                { 
                  text: 'Test', 
                  onPress: () => {
                    TextToSpeechService.speak('Emergency alert test activated');
                    setTimeout(() => {
                      Alert.alert('Test Complete', 'Emergency alert system is working correctly');
                    }, 2000);
                  }
                }
              ]
            );
          }}
          variant="outlined"
          size="medium"
          fullWidth
          icon={<Ionicons name="alert-circle-outline" size={18} color={COLORS.danger} />}
          style={styles.actionButton}
        />
      </Card>
      <Card 
        title="Detection Settings" 
        variant="default"
        icon={<MaterialCommunityIcons name="eye-settings" size={24} color={COLORS.info} />}
      >
        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>Precision Mode</Text>
            <Text style={styles.settingDescription}>Higher accuracy, fewer false positives</Text>
          </View>
          <Switch
            value={precisionMode}
            onValueChange={async (v) => {
              setPrecisionMode(v);
              await applyDetectionConfig({ precisionMode: v });
              if (ttsEnabled) TextToSpeechService.speak(v ? 'Precision mode enabled' : 'Precision mode disabled');
            }}
            trackColor={{ false: '#D1D1D6', true: '#34C759' }}
            thumbColor="#FFFFFF"
          />
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingInfo}>
            <Text style={styles.settingLabel}>Refinement Pass</Text>
            <Text style={styles.settingDescription}>Additional processing for accuracy</Text>
          </View>
          <Switch
            value={refinementPass}
            onValueChange={async (v) => {
              setRefinementPass(v);
              await applyDetectionConfig({ refinementPass: v });
              if (ttsEnabled) TextToSpeechService.speak(v ? 'Refinement enabled' : 'Refinement disabled');
            }}
            trackColor={{ false: '#D1D1D6', true: '#34C759' }}
            thumbColor="#FFFFFF"
          />
        </View>
      </Card>
      <Card 
        title="Audio Settings" 
        variant="elevated"
        icon={<Ionicons name="volume-high" size={24} color={COLORS.accent} />}
      >
        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Spatial Audio</Text>
          <Switch
            value={audioEnabled}
            onValueChange={handleAudioToggle}
            trackColor={{ false: '#D1D1D6', true: '#34C759' }}
            thumbColor="#FFFFFF"
          />
        </View>
        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Text-to-Speech</Text>
          <Switch
            value={ttsEnabled}
            onValueChange={handleTTSToggle}
            trackColor={{ false: '#D1D1D6', true: '#34C759' }}
            thumbColor="#FFFFFF"
          />
        </View>
        <View style={styles.buttonSpacing} />
        <Button
          title="Test Audio"
          onPress={handleTestAudio}
          variant="secondary"
          size="medium"
          fullWidth
        />
      </Card>
      <Card title="Haptic Feedback" variant="default">
        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Enable Haptics</Text>
          <Switch
            value={hapticEnabled}
            onValueChange={handleHapticToggle}
            trackColor={{ false: '#D1D1D6', true: '#34C759' }}
            thumbColor="#FFFFFF"
          />
        </View>
      </Card>
      <Card 
        title="Bluetooth Devices" 
        variant="default"
        icon={<MaterialCommunityIcons name="bluetooth" size={24} color={COLORS.info} />}
      >
        <View style={styles.bluetoothInfo}>
          <Text style={styles.bluetoothStatus}>
            Status: {bluetoothEnabled ? 'Connected' : 'Disconnected'}
          </Text>
          <Text style={styles.deviceCount}>
            Connected Devices: {connectedDevices.length}
          </Text>
        </View>
        {connectedDevices.map((device, index) => (
          <View key={index} style={styles.deviceItem}>
            <MaterialCommunityIcons name="bluetooth-connect" size={20} color={COLORS.primary} />
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceName}>{device.name}</Text>
              <Text style={styles.deviceId}>{device.id}</Text>
            </View>
          </View>
        ))}
        <View style={styles.buttonGroup}>
          <Button
            title={isScanning ? 'Scanning...' : 'Scan Devices'}
            onPress={handleScanDevices}
            variant="primary"
            size="medium"
            fullWidth
            disabled={isScanning}
            gradient={!isScanning}
            icon={<Ionicons name="search" size={18} color={COLORS.dark} />}
          />
          {connectedDevices.length > 0 && (
            <>
              <View style={styles.buttonSpacing} />
              <Button
                title="Disconnect All"
                onPress={handleDisconnectAll}
                variant="danger"
                size="medium"
                fullWidth
                icon={<Ionicons name="close-circle" size={18} color={COLORS.text} />}
              />
            </>
          )}
        </View>
      </Card>
      <Card 
        title="About" 
        variant="default"
        icon={<Ionicons name="information-circle" size={24} color={COLORS.warning} />}
      >
        <View style={styles.aboutContainer}>
          <Text style={styles.aboutText}>SENSEI - Smart Environmental Navigation System</Text>
          <Text style={styles.aboutVersion}>Version 1.0.0</Text>
          <Text style={styles.aboutDescription}>
            An AI-powered navigation assistant for enhanced independence
          </Text>
        </View>
        <Button
          title="Logout"
          onPress={() => {
            Alert.alert(
              'Logout',
              'Are you sure you want to logout?',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Logout',
                  style: 'destructive',
                  onPress: async () => {
                    await ApiService.logout();
                    TextToSpeechService.speak('Logged out successfully');
                    // Force app to restart to show auth screen
                    // In production, use proper navigation reset or context
                  }
                }
              ]
            );
          }}
          variant="danger"
          size="medium"
          fullWidth
          icon={<Ionicons name="log-out" size={18} color={COLORS.text} />}
          style={styles.actionButton}
        />
      </Card>
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
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '400',
    color: COLORS.textSecondary,
  },
  navigationItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  navigationLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  navigationInfo: {
    marginLeft: SPACING.md,
    flex: 1,
  },
  navigationTitle: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
  },
  navigationSubtitle: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs / 2,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  settingInfo: {
    flex: 1,
    marginRight: SPACING.md,
  },
  settingLabel: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
  },
  settingDescription: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs / 2,
  },
  actionButton: {
    marginTop: SPACING.md,
  },
  buttonSpacing: {
    height: SPACING.md,
  },
  bluetoothInfo: {
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.md,
  },
  bluetoothStatus: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: SPACING.xs / 2,
  },
  deviceCount: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
  },
  deviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: SPACING.sm,
  },
  deviceInfo: {
    marginLeft: SPACING.md,
    flex: 1,
  },
  deviceName: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    color: COLORS.text,
  },
  deviceId: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs / 2,
  },
  buttonGroup: {
    marginTop: SPACING.md,
  },
  aboutContainer: {
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  aboutText: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    paddingVertical: SPACING.xs,
    textAlign: 'center',
    fontWeight: '600',
  },
  aboutVersion: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    paddingVertical: SPACING.xs,
  },
  aboutDescription: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    paddingVertical: SPACING.xs,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
});
export default SettingsScreen;
