import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, BORDER_RADIUS, SPACING, FONT_SIZES } from '../constants/theme';
const Card = ({ 
  title, 
  description, 
  onPress, 
  icon = null,
  variant = 'default',
  children,
  gradient = false 
}) => {
  const cardStyles = [
    styles.card,
    styles[variant],
  ];
  const CardContent = (
    <View style={styles.container}>
      {icon && (
        <View style={styles.iconContainer}>
          {icon}
        </View>
      )}
      <View style={styles.content}>
        {title && <Text style={styles.title}>{title}</Text>}
        {description && <Text style={styles.description}>{description}</Text>}
        {children}
      </View>
    </View>
  );
  if (gradient && variant === 'highlighted') {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.9}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={[cardStyles, { padding: 0, overflow: 'hidden' }]}
      >
        <LinearGradient
          colors={[COLORS.cardBackground, COLORS.cardBackgroundLight]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gradientCard}
        >
          {CardContent}
        </LinearGradient>
      </TouchableOpacity>
    );
  }
  if (onPress) {
    return (
      <TouchableOpacity
        style={cardStyles}
        onPress={onPress}
        activeOpacity={0.9}
        accessibilityRole="button"
        accessibilityLabel={title}
      >
        {CardContent}
      </TouchableOpacity>
    );
  }
  return (
    <View style={cardStyles}>
      {CardContent}
    </View>
  );
};
const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.cardBackground,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginVertical: SPACING.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  gradientCard: {
    padding: SPACING.lg,
    width: '100%',
  },
  default: {
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  elevated: {
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  highlighted: {
    borderWidth: 2,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.cardBackgroundLight,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  iconContainer: {
    marginRight: SPACING.md,
    width: 48,
    height: 48,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.cardBackgroundLight,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  description: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '400',
    color: COLORS.textSecondary,
    lineHeight: 20,
  },
});
export default Card;
