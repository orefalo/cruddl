import {
    DocumentNode, FieldNode, FragmentDefinitionNode, getNamedType, GraphQLCompositeType, GraphQLField,
    GraphQLObjectType, GraphQLOutputType, GraphQLSchema, isCompositeType, OperationDefinitionNode, OperationTypeNode,
    SelectionNode
} from 'graphql';

import { getArgumentValues, getVariableValues, resolveSelections } from './field-collection';
import { arrayToObject, flatMap, groupArray, indent, INDENTATION } from '../utils/utils';
import { extractOperation } from './operations';
import { getOperationRootType } from './schema-utils';
import { getAliasOrName } from './language-utils';

/**
 * A request for the value of one field with a specific argument set and selection set
 */
export class FieldRequest {
    constructor(public readonly field: GraphQLField<any, any>,
                public readonly parentType: GraphQLCompositeType,
                public readonly selectionSet: FieldSelection[] = [],
                public readonly args: { [argumentName: string ]: any } = {}) {
    }

    public get fieldName() {
        return this.field.name;
    }

    /**
     * Finds a fieldRequest in the selection set that matches the given name
     *
     * This is here to ease transition. Finally, it should no longer be used because it disregards aliases.
     * @param fieldName
     * @returns the FieldRequest for the given field, or null if it was not requested
     */
    public getChildField(fieldName: string) {
        return this.selectionSet
            .filter(selection => selection.fieldRequest.fieldName == fieldName)
            .map(selection => selection.fieldRequest)
            [0] || null;
    }

    public describe(): string {
        const selectionItemsDesc = this.selectionSet
            .map(selection => `${JSON.stringify(selection.propertyName)}: ${selection.fieldRequest.describe()}`)
            .join(',\n');
        const selectionDesc = selectionItemsDesc ? ` with selections {\n${indent(selectionItemsDesc)}\n}` : '';
        const argsDesc = (this.args && Object.getOwnPropertyNames(this.args).length) ?
            ` with args ${JSON.stringify(this.args, null, INDENTATION)}` : '';

        return `field ${this.fieldName}${argsDesc}${selectionDesc}`;
    }
}

/**
 * A request for a field within a selection set. This is what gives a {@link FieldRequest} a property name in the result
 */
export class FieldSelection {
    /**
     * @param propertyName the name of the property the field request's value should be put in
     * @param fieldRequest determines the value for that property
     */
    constructor(public readonly propertyName: string,
                public readonly fieldRequest: FieldRequest) {

    }
}

/**
 * A simple description of a GraphQL operation
 */
export class DistilledOperation {
    constructor(public readonly operation: OperationTypeNode, public readonly selectionSet: FieldSelection[]) {}
}

interface FieldRequestConfig {
    field: GraphQLField<any, any>;
    parentType: GraphQLCompositeType;
    selectionSet?: SelectionSetConfig
    args?: { [argumentName: string ]: any };
}

export type SelectionSetConfig = { [ propertyName: string]: FieldRequestConfig };

/**
 * Creates a {@link FieldRequest} from a simple JSON-like object
 * @param config the config
 * @returns {FieldRequest} the created field request
 */
export function createFieldRequest(config: FieldRequestConfig) {
    return new FieldRequest(config.field, config.parentType, createSelectionSet(config.selectionSet || {}), config.args || {});
}

function createSelectionSet(config: SelectionSetConfig): FieldSelection[] {
    const selections = [];
    for (const key in config) {
        selections.push(new FieldSelection(key, createFieldRequest(config[key])));
    }
    return selections;
}

export interface OperationDistillationParams {
    schema: GraphQLSchema
    operation: OperationDefinitionNode
    variableValues: { [name: string]: any }
    fragments: { [fragmentName: string]: FragmentDefinitionNode }
}

/**
 * Creates a simplified description of an operation definition
 */
export function distillOperation(params: OperationDistillationParams): DistilledOperation {
    // needed to coerce values
    // not really sure when we should do this
    // I think it's idempotent, so won't do much harm except from performance penality
    const variableValues = getVariableValues(params.schema, params.operation.variableDefinitions || [], params.variableValues);
    const context = {
        variableValues,
        fragments: params.fragments
    };

    const parentType = getOperationRootType(params.schema, params.operation.operation);
    if (!parentType) {
        throw new Error(`Schema does not have a ${params.operation.operation} root type`);
    }
    const selections = distillSelections(params.operation.selectionSet.selections, parentType, context);
    return new DistilledOperation(params.operation.operation, selections)
}

export interface QueryDistillationParams {
    schema: GraphQLSchema
    document: DocumentNode
    variableValues: { [name: string]: any }
    operationName?: string
}

/**
 * Creates a simplified description of an operation in a query
 */
export function distillQuery(document: DocumentNode, schema: GraphQLSchema, variableValues: { [ name: string]: any} = {}, operationName?: string): DistilledOperation {
    return distillOperation({
        schema,
        operation: extractOperation(document, operationName),
        fragments: arrayToObject(document.definitions.filter(def => def.kind == 'FragmentDefinition') as FragmentDefinitionNode[], def => def.name.value),
        variableValues
    });
}

interface Context {
    fragments: { [fragmentName: string]: FragmentDefinitionNode };
    variableValues: { [variableName: string]: any };
}

/**
 * Creates simplified FieldSelection objects for a set of SelectionNodes
 */
function distillSelections(selections: SelectionNode[], parentType: GraphQLCompositeType, context: Context): FieldSelection[] {
    const allFieldNodes: FieldNode[] = resolveSelections(selections, context);
    const fieldNodesByPropertyName = groupArray(allFieldNodes, selection => getAliasOrName(selection));
    return [...fieldNodesByPropertyName].map(([propertyName, fieldNodes]) =>
        new FieldSelection(propertyName, buildFieldRequest(fieldNodes, parentType, context)));
}

/**
 * Builds a {@link FieldRequest} representation of what is requested
 *
 * The purpose of this function is to parse a GraphQL query into a nicely-consumable tree of requested fields.
 *
 * It implements features as directives (@includes and @skip), fragments (inline and name), aliases, variables and
 * multi-selections (providing a field name multiple times). The user gets a description of what exactly needs to be
 * returned to the client.
 *
 * Not supported are unions, interfaces and possibly other features.
 */
function buildFieldRequest(fieldNodes: Array<FieldNode>, parentType: GraphQLCompositeType, context: Context): FieldRequest {
    const fieldName = fieldNodes[0].name.value;

    if (!(parentType instanceof GraphQLObjectType)) {
        throw new Error(`Interfaces and union types are not supported yet`);
    }
    const fieldDef = parentType.getFields()[fieldName];
    if (!fieldDef) {
        throw new Error(`Field ${fieldName} is not defined in parent type ${parentType}`);
    }

    let selections: FieldSelection[] = [];
    const compositeFieldType = unwrapToCompositeType(fieldDef.type);
    if (compositeFieldType) {
        const childFieldNodes = flatMap(fieldNodes, node => node.selectionSet ? node.selectionSet.selections : []);
        selections = distillSelections(childFieldNodes, compositeFieldType, context);
    }

    // GraphQL disallows multiple requests of the same field with different arguments and same alias, so we can just pick one
    const args = getArgumentValues(fieldDef, fieldNodes[0], context.variableValues);
    return new FieldRequest(fieldDef, parentType, selections, args);
}

export function unwrapToCompositeType(type: GraphQLOutputType): GraphQLCompositeType | undefined {
    const namedType = getNamedType(type);
    if (isCompositeType(namedType)) {
        return namedType;
    }
    return undefined;
}