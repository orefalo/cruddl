import { expect } from 'chai';
import { Model, RootEntityType, Severity, TypeKind } from '../../../src/model';
import {
    expectMultipleMessagesToInclude, expectSingleErrorToInclude, expectToBeValid, validate
} from './validation-utils';

describe('RootEntityType', () => {
    const modelWithoutDefaultProfile = new Model({
        types: [
            {
                name: 'Address',
                kind: TypeKind.VALUE_OBJECT,
                fields: [
                    {
                        name: 'name',
                        typeName: 'String'
                    }
                ]
            }
        ]
    });

    const model = new Model({
        types: [
            {
                name: 'Address',
                kind: TypeKind.VALUE_OBJECT,
                fields: [
                    {
                        name: 'name',
                        typeName: 'String'
                    }
                ]
            }
        ],
        permissionProfiles: {
            default: {
                permissions: [
                    {
                        roles: ['everyone'],
                        access: 'read'
                    }
                ]
            },
            accounting: {
                permissions: [
                    {
                        roles: ['accounting'],
                        access: 'read'
                    }
                ]
            }
        }
    });

    describe('with key field', () => {
        it('accepts a scalar field', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                keyFieldName: 'deliveryNumber'
            }, model);

            expectToBeValid(type);
        });

        it('provides it as keyField', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                keyFieldName: 'deliveryNumber'
            }, model);

            expect(type.keyField).to.equal(type.getFieldOrThrow('deliveryNumber'));
        });

        it('rejects a non-existing field', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'barCodes',
                        typeName: 'String',
                        isList: true
                    }
                ],
                keyFieldName: 'undefined'
            }, model);

            expectSingleErrorToInclude(type, `Field "undefined" does not exist on type "Delivery".`);
        });

        it('rejects a list field', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'barCodes',
                        typeName: 'String',
                        isList: true
                    }
                ],
                keyFieldName: 'barCodes'
            }, model);

            expectSingleErrorToInclude(type, `List fields cannot be used as key field.`);
        });

        it('rejects an object type field', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'address',
                        typeName: 'Address'
                    }
                ],
                keyFieldName: 'address'
            }, model);

            expectMultipleMessagesToInclude(type, `Only fields of type "String", "Int", and "ID" can be used as key field.`, Severity.Error, 2);
        });

        it('creates a unique index for it', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    },
                    {
                        name: 'isShipped',
                        typeName: 'Boolean'
                    }
                ],
                keyFieldName: 'deliveryNumber',
                indices: [
                    {
                        fields: ['isShipped']
                    }
                ]
            }, model);

            expect(type.indices).to.have.lengthOf(2);
            expect(type.indices[0].fields.map(f => f.dotSeparatedPath)).to.deep.equal(['isShipped']);
            expect(type.indices[0].unique).to.equal(false);
            expect(type.indices[1].fields.map(f => f.dotSeparatedPath)).to.deep.equal(['deliveryNumber']);
            expect(type.indices[1].unique).to.equal(true);
        });

        it('does not add a unique index if it already exists', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                keyFieldName: 'deliveryNumber',
                indices: [
                    {
                        fields: ['deliveryNumber'],
                        unique: true
                    }
                ]
            }, model);

            expect(type.indices).to.have.lengthOf(1);
            expect(type.indices[0].fields.map(f => f.dotSeparatedPath)).to.deep.equal(['deliveryNumber']);
            expect(type.indices[0].unique).to.equal(true);
        });

        it('adds an index if the existing one is not unique', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                keyFieldName: 'deliveryNumber',
                indices: [
                    {
                        fields: ['deliveryNumber']
                    }
                ]
            }, model);

            expect(type.indices).to.have.lengthOf(2);
            expect(type.indices[0].fields.map(f => f.dotSeparatedPath)).to.deep.equal(['deliveryNumber']);
            expect(type.indices[0].unique).to.equal(false);
            expect(type.indices[1].fields.map(f => f.dotSeparatedPath)).to.deep.equal(['deliveryNumber']);
            expect(type.indices[1].unique).to.equal(true);
        });
    });

    describe('with permissions field', () => {
        describe('with permission profile', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                permissions: {
                    permissionProfileName: 'accounting'
                }
            }, model);

            it('accepts', () => {
                expectToBeValid(type);
            });

            it('resolves permission profile', () => {
                expect(type.permissionProfile).to.equal(model.getPermissionProfileOrThrow('accounting'));
            });
        });

        it('accepts direct role specifier', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                permissions: {
                    roles: {
                        read: ['accounting']
                    }
                }
            }, model);

            expectToBeValid(type);
        });

        it('rejects combining roles and permission profiles', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                permissions: {
                    roles: {
                        read: ['accounting']
                    },
                    permissionProfileName: 'accounting'
                }
            }, model);

            const result = validate(type);
            expect(result.messages.length, result.toString()).to.equal(2);
            for (const message of result.messages) {
                expect(message.severity).to.equal(Severity.Error);
                expect(message.message).to.equal(`Permission profile and explicit role specifiers cannot be combined.`);
            }
        });

        it('rejects missing permission profile', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                permissions: {
                    permissionProfileName: 'undefined'
                }
            }, model);

            expectSingleErrorToInclude(type, `Permission profile "undefined" not found`);
        });

        it('rejects with neither roles nor permission profile', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ]
            }, modelWithoutDefaultProfile);

            expectSingleErrorToInclude(type, `No permissions specified for root entity "Delivery". Specify "permissionProfile" in @rootEntity, use the @roles directive, or add a permission profile with the name "default".`);
        });

        it('accepts with neither roles nor permission profile, but default profile in model', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ]
            }, model);

            expectToBeValid(type);
        });

        it('provides default profile as profile if no permissions are specified', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ]
            }, model);

            expect(type.permissionProfile).to.equal(model.getPermissionProfileOrThrow('default'));
        });

        it('provides no profile if roles are specified', () => {
            const type = new RootEntityType({
                kind: TypeKind.ROOT_ENTITY,
                name: 'Delivery',
                fields: [
                    {
                        name: 'deliveryNumber',
                        typeName: 'String'
                    }
                ],
                permissions: {
                    roles: {}
                }
            }, model);

            expect(type.permissionProfile).to.be.undefined;
        });
    });
});