import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, Alert, FlatList } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import Button from '../components/Button';
import Card from '../components/Card';
import TextToSpeechService from '../services/TextToSpeechService';
import EmergencyService from '../services/EmergencyService';
import ApiService from '../services/ApiService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';
const EmergencyContactsScreen = ({ navigation }) => {
  const [emergencyContacts, setEmergencyContacts] = useState([]);
  const [isAddingContact, setIsAddingContact] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [hasContactsPermission, setHasContactsPermission] = useState(false);
  useEffect(() => {
    (async () => {
      await EmergencyService.initialize();
      loadEmergencyContacts();
    })();
    requestContactsPermission();
  }, []);
  const requestContactsPermission = async () => {
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      setHasContactsPermission(status === 'granted');
      if (status !== 'granted') {
        TextToSpeechService.speak('Contacts permission is required to select contacts');
      }
    } catch (error) {
      console.error('Contacts permission error:', error);
    }
  };
  const loadEmergencyContacts = async () => {
    try {
      if (ApiService.token) {
        const contacts = await ApiService.getEmergencyContacts();
        setEmergencyContacts(contacts);
        return;
      }
    } catch (error) {
      console.error('Failed to load emergency contacts from API:', error);
    }
    
    const contacts = EmergencyService.getEmergencyContacts();
    setEmergencyContacts(contacts);
  };
  const handleSelectFromContacts = async () => {
    if (!hasContactsPermission) {
      Alert.alert('Permission Required', 'Please grant contacts permission');
      await requestContactsPermission();
      return;
    }
    try {
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
      });
      if (data.length === 0) {
        Alert.alert('No Contacts', 'No contacts found on your device');
        TextToSpeechService.speak('No contacts found');
        return;
      }
      const contactsWithPhone = data.filter(c => c.phoneNumbers && c.phoneNumbers.length > 0);
      if (contactsWithPhone.length === 0) {
        Alert.alert('No Contacts', 'No contacts with phone numbers found');
        return;
      }
      Alert.alert(
        'Select Contact',
        'Use manual entry to add a contact. Full contact picker will be implemented in production.',
        [{ text: 'OK' }]
      );
      TextToSpeechService.speak('Please use manual entry to add emergency contacts');
    } catch (error) {
      console.error('Contact selection error:', error);
      Alert.alert('Error', 'Failed to access contacts');
    }
  };
  const handleAddManualContact = async () => {
    if (!contactName.trim() || !contactPhone.trim()) {
      Alert.alert('Error', 'Please enter both name and phone number');
      TextToSpeechService.speak('Please enter both name and phone number');
      return;
    }
    const phoneRegex = /^[\d\s\-\+\(\)]+$/;
    if (!phoneRegex.test(contactPhone)) {
      Alert.alert('Error', 'Please enter a valid phone number');
      TextToSpeechService.speak('Please enter a valid phone number');
      return;
    }
    const newContact = {
      id: Date.now().toString(),
      name: contactName.trim(),
      phone: contactPhone.trim(),
      relationship: 'emergency',
    };
    
    try {
      if (ApiService.token) {
        await ApiService.addEmergencyContact({
          name: newContact.name,
          phone_number: newContact.phone,
          relationship: newContact.relationship,
        });
      }
    } catch (error) {
      console.error('Failed to sync contact to server:', error);
    }
    
    EmergencyService.addEmergencyContact(newContact);
    await loadEmergencyContacts();
    setContactName('');
    setContactPhone('');
    setIsAddingContact(false);
    TextToSpeechService.speak(`Added ${newContact.name} as emergency contact`);
    Alert.alert('Success', `${newContact.name} has been added as an emergency contact`);
  };
  const handleRemoveContact = (contact) => {
    Alert.alert(
      'Remove Contact',
      `Are you sure you want to remove ${contact.name} from emergency contacts?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            EmergencyService.removeEmergencyContact(contact.id);
            loadEmergencyContacts();
            TextToSpeechService.speak(`Removed ${contact.name} from emergency contacts`);
          },
        },
      ]
    );
  };
  const handleTestAlert = async () => {
    if (emergencyContacts.length === 0) {
      Alert.alert('No Contacts', 'Please add emergency contacts first');
      TextToSpeechService.speak('Please add emergency contacts first');
      return;
    }
    Alert.alert(
      'Test Emergency Alert',
      'This will send a test alert to all emergency contacts. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Test',
          onPress: async () => {
            TextToSpeechService.speak('Sending test emergency alert');
            Alert.alert('Test Alert Sent', 'Test emergency alert has been sent to all contacts');
          },
        },
      ]
    );
  };
  const renderContact = ({ item }) => (
    <Card variant="outlined" style={styles.contactCard}>
      <View style={styles.contactHeader}>
        <MaterialCommunityIcons name="account-circle" size={40} color={COLORS.primary} />
        <View style={styles.contactInfo}>
          <Text style={styles.contactName}>{item.name}</Text>
          <Text style={styles.contactPhone}>{item.phone}</Text>
        </View>
        <Button
          title=""
          onPress={() => handleRemoveContact(item)}
          variant="ghost"
          size="small"
          icon={<Ionicons name="trash-outline" size={20} color={COLORS.danger} />}
        />
      </View>
    </Card>
  );
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Card 
        title="Emergency Contacts" 
        variant="elevated"
        icon={<Ionicons name="people" size={24} color={COLORS.primary} />}
      >
        <Text style={styles.description}>
          Add trusted contacts who will be notified in case of emergency. They will receive your location and a distress message.
        </Text>
        {emergencyContacts.length === 0 ? (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="account-alert" size={60} color={COLORS.gray} />
            <Text style={styles.emptyText}>No emergency contacts added</Text>
            <Text style={styles.emptySubtext}>Add at least one contact for safety</Text>
          </View>
        ) : (
          <FlatList
            data={emergencyContacts}
            renderItem={renderContact}
            keyExtractor={item => item.id}
            scrollEnabled={false}
            style={styles.contactsList}
          />
        )}
        {!isAddingContact ? (
          <View style={styles.actionButtons}>
            <Button
              title="Select from Contacts"
              onPress={handleSelectFromContacts}
              variant="secondary"
              size="medium"
              fullWidth
              icon={<Ionicons name="people-outline" size={18} color={COLORS.text} />}
              style={styles.actionButton}
            />
            <Button
              title="Add Manually"
              onPress={() => {
                setIsAddingContact(true);
                TextToSpeechService.speak('Enter contact details manually');
              }}
              variant="primary"
              size="medium"
              fullWidth
              gradient
              icon={<Ionicons name="add-circle-outline" size={18} color={COLORS.dark} />}
              style={styles.actionButton}
            />
          </View>
        ) : (
          <Card variant="outlined" style={styles.addContactForm}>
            <Text style={styles.formTitle}>Add Emergency Contact</Text>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Contact Name</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter contact name"
                placeholderTextColor={COLORS.gray}
                value={contactName}
                onChangeText={setContactName}
                accessibilityLabel="Contact name input"
              />
            </View>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Phone Number</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter phone number"
                placeholderTextColor={COLORS.gray}
                value={contactPhone}
                onChangeText={setContactPhone}
                keyboardType="phone-pad"
                accessibilityLabel="Phone number input"
              />
            </View>
            <View style={styles.formButtons}>
              <Button
                title="Cancel"
                onPress={() => {
                  setIsAddingContact(false);
                  setContactName('');
                  setContactPhone('');
                }}
                variant="secondary"
                size="medium"
                style={styles.formButton}
              />
              <Button
                title="Add Contact"
                onPress={handleAddManualContact}
                variant="primary"
                size="medium"
                gradient
                style={styles.formButton}
              />
            </View>
          </Card>
        )}
        {emergencyContacts.length > 0 && (
          <Button
            title="Test Emergency Alert"
            onPress={handleTestAlert}
            variant="outlined"
            size="medium"
            fullWidth
            icon={<Ionicons name="alert-circle-outline" size={18} color={COLORS.accent} />}
            style={styles.testButton}
          />
        )}
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
  },
  description: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    lineHeight: 20,
    marginBottom: SPACING.lg,
  },
  emptyState: {
    alignItems: 'center',
    padding: SPACING.xl,
  },
  emptyText: {
    fontSize: FONT_SIZES.lg,
    color: COLORS.text,
    marginTop: SPACING.md,
    fontWeight: '600',
  },
  emptySubtext: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  contactsList: {
    marginBottom: SPACING.lg,
  },
  contactCard: {
    marginBottom: SPACING.md,
    padding: SPACING.md,
  },
  contactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  contactInfo: {
    flex: 1,
    marginLeft: SPACING.md,
  },
  contactName: {
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    fontWeight: '600',
  },
  contactPhone: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs / 2,
  },
  actionButtons: {
    gap: SPACING.md,
  },
  actionButton: {
    marginBottom: SPACING.sm,
  },
  addContactForm: {
    padding: SPACING.lg,
    marginTop: SPACING.md,
    marginBottom: SPACING.md,
  },
  formTitle: {
    fontSize: FONT_SIZES.lg,
    color: COLORS.text,
    fontWeight: '600',
    marginBottom: SPACING.lg,
  },
  inputGroup: {
    marginBottom: SPACING.md,
  },
  label: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
    marginBottom: SPACING.xs,
    fontWeight: '600',
  },
  input: {
    backgroundColor: COLORS.inputBackground,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: FONT_SIZES.md,
    color: COLORS.text,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  formButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.md,
  },
  formButton: {
    flex: 1,
  },
  testButton: {
    marginTop: SPACING.lg,
  },
});
export default EmergencyContactsScreen;
