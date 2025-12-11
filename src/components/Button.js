import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, BORDER_RADIUS, SPACING, FONT_SIZES } from '../constants/theme';
const { width } = Dimensions.get('window');
const Button = ({ 
  title, 
  onPress, 
  variant = 'primary', 
  disabled = false,
  size = 'medium',
  fullWidth = false,
  icon = null,
  gradient = false 
}) => {
  const buttonStyles = [
    styles.button,
    styles[variant],
    fullWidth && styles.fullWidth,
    disabled && styles.disabled,
  ];
  const textStyles = [
    styles.text,
    styles[`${variant}Text`],
    styles[`${size}Text`],
    disabled && styles.disabledText,
  ];
  const sizeStyle = styles[size];
  const content = (
    <View style={styles.content}>
      {icon && <View style={styles.icon}>{icon}</View>}
      <Text style={textStyles}>{title}</Text>
    </View>
  );
  if (gradient && variant === 'primary' && !disabled) {
    return (
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={[buttonStyles, { backgroundColor: 'transparent' }]}
      >
        <LinearGradient
          colors={[COLORS.primary, COLORS.secondary]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.gradient, sizeStyle, fullWidth && styles.fullWidth]}
        >
          {content}
        </LinearGradient>
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity
      style={[...buttonStyles, sizeStyle]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      {content}
    </TouchableOpacity>
  );
};
const styles = StyleSheet.create({
  button: {
    borderRadius: BORDER_RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  gradient: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BORDER_RADIUS.md,
  },
  primary: {
    backgroundColor: COLORS.primary,
  },
  secondary: {
    backgroundColor: COLORS.secondary,
  },
  success: {
    backgroundColor: COLORS.success,
  },
  danger: {
    backgroundColor: COLORS.danger,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  ghost: {
    backgroundColor: COLORS.cardBackgroundLight,
  },
  small: {
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    minHeight: 28,
  },
  medium: {
    paddingVertical: 6,
    paddingHorizontal: SPACING.lg,
    minHeight: 36,
  },
  large: {
    paddingVertical: 8,
    paddingHorizontal: SPACING.xl,
    minHeight: 44,
  },
  fullWidth: {
    width: '100%',
  },
  disabled: {
    opacity: 0.5,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    marginRight: SPACING.sm,
  },
  text: {
    fontWeight: '600',
    textAlign: 'center',
  },
  primaryText: {
    color: COLORS.dark,
    fontWeight: 'bold',
  },
  secondaryText: {
    color: COLORS.text,
    fontWeight: 'bold',
  },
  successText: {
    color: COLORS.text,
    fontWeight: 'bold',
  },
  dangerText: {
    color: COLORS.text,
    fontWeight: 'bold',
  },
  outlineText: {
    color: COLORS.primary,
    fontWeight: 'bold',
  },
  ghostText: {
    color: COLORS.text,
    fontWeight: '600',
  },
  smallText: {
    fontSize: FONT_SIZES.sm,
  },
  mediumText: {
    fontSize: FONT_SIZES.md,
  },
  largeText: {
    fontSize: FONT_SIZES.lg,
  },
  disabledText: {
    opacity: 0.6,
  },
});
export default Button;
