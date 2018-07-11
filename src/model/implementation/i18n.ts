import * as pluralize from 'pluralize';
import memorize from 'memorize-decorator';
import { globalContext } from '../../config/global';
import { I18N_GENERIC, I18N_WARNING } from '../../meta-schema/constants';
import { NAMESPACE_SEPARATOR } from '../../schema/constants';
import {
    arrayStartsWith, capitalize, compact, decapitalize, groupArray, mapFirstDefined} from '../../utils/utils';
import { LocalizationConfig, NamespaceLocalizationConfig } from '../config/i18n';
import { MessageLocation, ValidationMessage } from '../validation';
import { ModelComponent, ValidationContext } from '../validation/validation-context';
import { Field } from './field';
import { Model } from './model';
import { ObjectTypeBase } from './object-type-base';

export class ModelI18n implements ModelComponent {

    private readonly languageLocalizationProvidersByLanguage: ReadonlyMap<string, ModelLocalizationProvider>;

    constructor(input: ReadonlyArray<LocalizationConfig>, private readonly model: Model) {
        // collect configs by language and create one list of namespaces per language
        // collect all countries for which namespaces must be created
        const configsByLanguage = groupArray(input, config => config.language);

        const localizationMap = new Map<string, ModelLocalizationProvider>();
        Array.from(configsByLanguage.keys()).forEach(language =>
            localizationMap.set(language, new ModelLocalizationProvider(configsByLanguage.get(language)!.map(
                config => config.namespaceContent)
                .map(flatNamespace => new NamespaceLocalization(flatNamespace))))
        );
        this.languageLocalizationProvidersByLanguage = localizationMap;
    }

    public validate(context: ValidationContext): void {
        for (const locPro of this.languageLocalizationProvidersByLanguage.values()) {
            locPro.validate(context);
        }
    }

    @memorize()
    public getTypeLocalization(type: ObjectTypeBase, resolutionOrder: ReadonlyArray<string>): TypeLocalization {
        const resolutionProviders = this.getResolutionProviders(resolutionOrder);
        // try to build one complete type localization out of the available possibly partial localizations
        return {
            singular: mapFirstDefined(resolutionProviders, rp => rp.localizeType(type).singular),
            plural: mapFirstDefined(resolutionProviders, rp => rp.localizeType(type).plural),
            hint: mapFirstDefined(resolutionProviders, rp => rp.localizeType(type).hint)
        };
    }

    @memorize()
    public getFieldLocalization(field: Field, resolutionOrder: ReadonlyArray<string>): FieldLocalization {
        const resolutionProviders = this.getResolutionProviders(resolutionOrder);
        // try to build one complete field localization out of the available possibly partial localizations

        return {
            label: mapFirstDefined(resolutionProviders, rp => rp.localizeField(field).label),
            hint: mapFirstDefined(resolutionProviders, rp => rp.localizeField(field).hint)
        };
    }

    private getResolutionProviders(resolutionOrder: ReadonlyArray<string>): ReadonlyArray<LocalizationProvider> {
        return compact(resolutionOrder.map(providerName => {
            switch (providerName) {
                case I18N_GENERIC:
                    return new GenericLocalizationProvider();
                case I18N_WARNING:
                    return new WarningLocalizationProvider(resolutionOrder);
                default:
                    return this.languageLocalizationProvidersByLanguage.get(providerName);
            }
        }));
    }


}

export class NamespaceLocalization {
    public readonly namespacePath: ReadonlyArray<string>;
    private readonly namespaceLocalizationConfig: NamespaceLocalizationConfig;

    constructor(input: NamespaceLocalizationConfig) {
        this.namespaceLocalizationConfig = input;
        this.namespacePath = input.namespacePath;
    }

    public getAllLocalizationsForType(name: string) {
        if (this.namespaceLocalizationConfig.types) {
            const type = this.namespaceLocalizationConfig.types[name];
            if (type) {
                return {
                    name: name,
                    singular: type.singular,
                    plural: type.plural,
                    hint: type.hint,
                    loc: type.loc
                };
            }
        }
        return null;
    }

    public getTypeLocalizationForField(name: string, type: string): FieldI18n | undefined {
        if (this.namespaceLocalizationConfig.types && this.namespaceLocalizationConfig.types[type]) {
            const fields = this.namespaceLocalizationConfig.types[type].fields;
            if (fields) {
                const field = fields[name];
                if (field) {
                    return {
                        name: name,
                        type: type,
                        hint: field.hint,
                        label: field.label,
                        loc: field.loc
                    };
                }
            }
        }
        return;
    }

    public getNamespaceLocalizationForField(name: string): FieldI18n | undefined {
        if (this.namespaceLocalizationConfig.fields && this.namespaceLocalizationConfig.fields[name]) {
            const field = this.namespaceLocalizationConfig.fields[name];
            return {
                name: name,
                hint: field.hint,
                label: field.label,
                loc: field.loc
            };
        }
        return;
    }

    get loc() {
        return this.namespaceLocalizationConfig.loc;
    }

    get types() {
        return this.namespaceLocalizationConfig.types;
    }

    get fields() {
        return this.namespaceLocalizationConfig.fields;
    }

}

export interface TypeLocalization {
    readonly singular?: string,
    readonly plural?: string,
    readonly hint?: string,
    readonly loc?: MessageLocation
}

export interface FieldLocalization {
    readonly label?: string,
    readonly hint?: string,
    readonly loc?: MessageLocation
}

export interface TypeI18n extends TypeLocalization {
    readonly name: string,
}

export interface FieldI18n extends FieldLocalization {
    readonly name: string,
    readonly type?: string
}

interface LocalizationProvider {
    localizeType(type: ObjectTypeBase): TypeLocalization;

    localizeField(field: Field): FieldLocalization;
}

class ModelLocalizationProvider implements LocalizationProvider {

    constructor(private namespaces: ReadonlyArray<NamespaceLocalization>) {
    }


    private getMatchingNamespaces(namespacePath: ReadonlyArray<string>): ReadonlyArray<NamespaceLocalization> {
        return this.namespaces.filter(set => arrayStartsWith(namespacePath, set.namespacePath))
            .sort((lhs, rhs) => lhs.namespacePath.length - rhs.namespacePath.length);
    }

    validate(validationContext: ValidationContext) {
        const groupedNamespaceLocalizations = groupArray(this.namespaces, ns => ns.namespacePath.join('/'));
        for (const key of groupedNamespaceLocalizations.keys()) {
            const namespaces = groupedNamespaceLocalizations.get(key);

            if (namespaces) {
                const alreadySeen: string[] = [];

                for (const ns of namespaces) {
                    if (ns.types) {
                        for (const type in ns.types) {
                            const typeConf = ns.types[type];
                            if (typeConf.hint && this.isExistingAndAdd(type + '/hint', alreadySeen)) {
                                validationContext.addMessage(ValidationMessage.error('The attribute "hint" in type "' + type + '" was defined several times in the i18n translation', typeConf.loc));
                            }
                            if (typeConf.singular && this.isExistingAndAdd(type + '/singular', alreadySeen)) {
                                validationContext.addMessage(ValidationMessage.error('The attribute "singular" in type "' + type + '" was defined several times in the i18n translation', typeConf.loc));
                            }
                            if (typeConf.plural && this.isExistingAndAdd(type + '/plural', alreadySeen)) {
                                validationContext.addMessage(ValidationMessage.error('The attribute "plural" in type "' + type + '" was defined several times in the i18n translation', typeConf.loc));
                            }

                            if (typeConf && typeConf.fields) {
                                for (const field in typeConf.fields) {
                                    const fieldConf = typeConf.fields[field];
                                    if (fieldConf&&fieldConf.label && this.isExistingAndAdd(type +'/'+field+'/label', alreadySeen)) {
                                        validationContext.addMessage(ValidationMessage.error('The attribute "label" in field "'+field+'" of type "' + type + '" was defined several times in the i18n translation', typeConf.loc));
                                    }
                                    if (fieldConf&&fieldConf.hint && this.isExistingAndAdd(type +'/'+field+'/hint', alreadySeen)) {
                                        validationContext.addMessage(ValidationMessage.error('The attribute "hint" in field "'+field+'" of type "' + type + '" was defined several times in the i18n translation', typeConf.loc));
                                    }
                                }
                            }
                        }
                    }
                }
            }

        }
    }

    private isExistingAndAdd(search: string, array: string[]) {
        if (array.indexOf(search) >= 0) {
            array.push(search);
            return true;
        }
        array.push(search);
        return false;
    }

    localizeType(type: ObjectTypeBase): TypeLocalization {
        const matchingNamespaces = this.getMatchingNamespaces(type.namespacePath);
        const matchingTypeLocalization = compact(matchingNamespaces.map(ns => ns.getAllLocalizationsForType(type.name)));
        return {
            singular: mapFirstDefined(matchingTypeLocalization, t => t.singular),
            plural: mapFirstDefined(matchingTypeLocalization, t => t.plural),
            hint: mapFirstDefined(matchingTypeLocalization, t => t.hint)
        };
    }

    localizeField(field: Field): FieldLocalization {
        const matchingNamespaces = this.getMatchingNamespaces(field.declaringType.namespacePath);

        let label: string | undefined;
        let hint: string | undefined;

        for (const namespace of matchingNamespaces) {
            const typeField = namespace.getTypeLocalizationForField(field.name, field.declaringType.name);
            if (typeField) {
                label = label ? label : typeField.label;
                hint = hint ? hint : typeField.hint;

                if (label && hint) {
                    break;
                }
            }
        }
        for (const namespace of matchingNamespaces) {
            const typeField = namespace.getNamespaceLocalizationForField(field.name);
            if (typeField) {
                label = label ? label : typeField.label;
                hint = hint ? hint : typeField.hint;
            }
            if (label && hint) {
                break;
            }
        }
        return { label: label, hint: hint };
    }

}

class GenericLocalizationProvider implements LocalizationProvider {

    localizeField(field: Field): FieldLocalization {
        return {
            label: generateGenericName(field.name)
        };
    }

    localizeType(type: ObjectTypeBase): TypeLocalization {
        return {
            singular: generateGenericName(type.name),
            plural: GenericLocalizationProvider.generatePluralName(type.name)
        };
    }

    static generatePluralName(name: string | undefined): string | undefined {
        name = generateGenericName(name);
        if (name == undefined || name === '') {
            return undefined;
        }
        let splitName = name.split(' ');
        return [...splitName, pluralize(splitName.pop()!)].join(' ');
    }
}

function generateGenericName(name: string | undefined): string | undefined {
    if (name == undefined) {
        return undefined;
    }
    return capitalize(name.replace(/([a-z])([A-Z])/g, (str, arg1, arg2) => `${arg1} ${decapitalize(arg2)}`));
}

class WarningLocalizationProvider implements LocalizationProvider {

    private resolutionOrderWithoutResult: ReadonlyArray<string>;

    constructor(resolutionOrder: ReadonlyArray<string>) {
        // create a list of all tried languages.
        this.resolutionOrderWithoutResult = resolutionOrder.slice(0, resolutionOrder.indexOf(I18N_WARNING));
    }

    logger = globalContext.loggerProvider.getLogger('i18n');

    localizeField(field: Field): FieldLocalization {
        this.logger.warn(`Missing i18n for field ${field.declaringType.namespacePath.join(NAMESPACE_SEPARATOR)}.${field.declaringType.name}.${field.name} in language: ${this.resolutionOrderWithoutResult.join(', ')}`);
        return {};
    }

    localizeType(type: ObjectTypeBase): TypeLocalization {
        this.logger.warn(`Missing i18n for type ${type.namespacePath.join(NAMESPACE_SEPARATOR)}.${type.name} in language: ${this.resolutionOrderWithoutResult.join(', ')}`);
        return {};
    }
}