import {
    FragmentDefinitionNode, GraphQLFieldConfigMap, GraphQLFieldResolver, GraphQLObjectType, GraphQLSchema,
    OperationDefinitionNode
} from 'graphql';
import { arrayToObject, objectValues } from '../utils/utils';
import { getAliasOrName } from './language-utils';

export interface OperationParams {
    schema: GraphQLSchema
    operation: OperationDefinitionNode
    variableValues: { [name: string]: any }
    fragments: { [fragmentName: string]: FragmentDefinitionNode }
}

/**
 * Adds resolvers to a schema that can execute a whole operation at once
 * @param {GraphQLSchema} schema
 * @param {(params: OperationParams)} resolver the callback function used to resolve one operation
 */
export function addOperationBasedResolvers(schema: GraphQLSchema, operationResolver: (params: OperationParams) => Promise<any>): GraphQLSchema {
    function convertType(type: GraphQLObjectType): GraphQLObjectType {
        const promises = new WeakMap<OperationDefinitionNode, Promise<any>>();
        const resolveOp: GraphQLFieldResolver<any, any> = (a, b, c, info) => {
            const cached = promises.get(info.operation);
            if (cached) {
                return cached;
            }
            const promise = operationResolver(info);
            promises.set(info.operation, promise);
            return promise;
        };

        const newFields: GraphQLFieldConfigMap<any, any> = {};
        for (const fieldName in type.getFields()) {
            const field = type.getFields()[fieldName];
            newFields[fieldName] = {
                type: field.type,
                description: field.description,
                deprecationReason: field.deprecationReason,
                args: arrayToObject(field.args, arg => arg.name),
                resolve: (a,b,c,info) => resolveOp(a,b,c,info).then((res: any) => res[getAliasOrName(info.fieldNodes[0])])
                // TODO add astNode once in typings
            };
        }

        return new GraphQLObjectType({
            ...type,
            fields: newFields
        });
    }

    const mut = schema.getMutationType();
    const sub = schema.getSubscriptionType();
    return new GraphQLSchema({
        query: convertType(schema.getQueryType()),
        mutation: mut ? convertType(mut) : undefined,
        subscription: sub ? convertType(sub) : undefined,
        directives: schema.getDirectives(),
        types: objectValues(schema.getTypeMap()).filter(t => t != mut && t != sub && t != schema.getQueryType())
    });
}
