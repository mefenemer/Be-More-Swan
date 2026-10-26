// src/public/assistant-onboarding-schemas.d.ts
// Types for the set-up questions, read on the server by src/utils/setup-field.ts. The file itself is
// plain .js because the browser's set-up wizard and profile read the same object.

export interface SchemaOption { value: string; label: string; description?: string }
export interface SchemaField {
    key: string;
    label: string;
    type: 'text' | 'textarea' | 'radio' | 'dropdown' | 'number';
    required?: boolean;
    placeholder?: string;
    helpText?: string;
    options?: SchemaOption[];
    min?: number;
    max?: number;
    defaultValue?: unknown;
}
export interface SchemaStep { title: string; description?: string; operational?: boolean; fields: SchemaField[] }

declare const schemas: Record<string, SchemaStep[]>;
export default schemas;
